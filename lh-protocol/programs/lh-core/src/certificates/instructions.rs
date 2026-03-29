use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::LhError;
use crate::events;
use crate::pyth;
use crate::state::*;

// ─── Buy Certificate ───────────────────────────────────────────────

#[derive(Accounts)]
pub struct BuyCertificate<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position_state.position_mint.as_ref()],
        bump = position_state.bump,
        constraint = position_state.owner == buyer.key() @ LhError::Unauthorized,
        constraint = position_state.status == position_status::LOCKED @ LhError::InvalidPositionStatus,
        constraint = position_state.protected_by.is_none() @ LhError::AlreadyProtected,
    )]
    pub position_state: Box<Account<'info, PositionState>>,

    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        mut,
        address = pool_state.usdc_vault,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_usdc.mint == pool_state.usdc_mint,
        constraint = buyer_usdc.owner == buyer.key(),
    )]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,

    pub template: Box<Account<'info, TemplateConfig>>,

    #[account(
        seeds = [REGIME_SEED, pool_state.key().as_ref()],
        bump = regime_snapshot.bump,
    )]
    pub regime_snapshot: Box<Account<'info, RegimeSnapshot>>,

    #[account(
        init,
        payer = buyer,
        space = CertificateState::SIZE,
        seeds = [CERTIFICATE_SEED, position_state.position_mint.as_ref()],
        bump,
    )]
    pub certificate_state: Box<Account<'info, CertificateState>>,

    /// Certificate NFT mint — created by the client with pool_state as authority
    #[account(
        mut,
        constraint = cert_mint.decimals == 0,
        constraint = cert_mint.mint_authority.contains(&pool_state.key()),
        constraint = cert_mint.supply == 0,
    )]
    pub cert_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = buyer_cert_ata.mint == cert_mint.key(),
        constraint = buyer_cert_ata.owner == buyer.key(),
    )]
    pub buyer_cert_ata: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_buy_certificate(
    ctx: Context<BuyCertificate>,
    cap_usdc: u64,
    lower_barrier_e6: u64,
    notional_usdc: u64,
) -> Result<()> {
    let template = &ctx.accounts.template;
    require!(template.active, LhError::TemplateInactive);

    // Verify regime snapshot freshness (max 15 minutes)
    let now = Clock::get()?.unix_timestamp;
    let regime = &ctx.accounts.regime_snapshot;
    require!(now - regime.updated_ts <= 900, LhError::StaleRegime);

    // Compute quote on-chain
    let quote = crate::pricing::compute_quote(
        cap_usdc,
        template,
        &ctx.accounts.pool_state,
        regime,
    )?;

    // Read values needed for CPI before mutable borrow
    let pool_bump = ctx.accounts.pool_state.bump;
    let pool_key = ctx.accounts.pool_state.key();
    let position_key = ctx.accounts.position_state.key();
    let template_id = template.template_id;
    let tenor_days = template.tenor_days;

    // Transfer premium from buyer to pool vault (buyer is signer, no PDA needed)
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        quote.premium_usdc,
    )?;

    // Mint certificate NFT to buyer (pool PDA is mint authority)
    let pool_seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.cert_mint.to_account_info(),
                to: ctx.accounts.buyer_cert_ata.to_account_info(),
                authority: ctx.accounts.pool_state.to_account_info(),
            },
            &[pool_seeds],
        ),
        1,
    )?;

    // Now take mutable borrows for state updates
    let pool = &mut ctx.accounts.pool_state;

    // Reserve exposure
    pool.active_cap_usdc = pool
        .active_cap_usdc
        .checked_add(quote.cap_usdc)
        .ok_or(LhError::Overflow)?;

    // Premium increases reserves (NAV model)
    pool.reserves_usdc = pool
        .reserves_usdc
        .checked_add(quote.premium_usdc)
        .ok_or(LhError::Overflow)?;

    // Compute expiry from template
    let expiry_ts = now + (tenor_days as i64) * 86_400;

    // Initialize certificate state
    let cert = &mut ctx.accounts.certificate_state;
    cert.owner = ctx.accounts.buyer.key();
    cert.position = position_key;
    cert.pool = pool_key;
    cert.template_id = template_id;
    cert.premium_usdc = quote.premium_usdc;
    cert.cap_usdc = quote.cap_usdc;
    cert.lower_barrier_e6 = lower_barrier_e6;
    cert.notional_usdc = notional_usdc;
    cert.expiry_ts = expiry_ts;
    cert.state = cert_status::ACTIVE;
    cert.nft_mint = ctx.accounts.cert_mint.key();
    cert.bump = ctx.bumps.certificate_state;

    // Mark position as protected
    let position = &mut ctx.accounts.position_state;
    position.protected_by = Some(cert.key());

    emit!(events::CertificateActivated {
        certificate: cert.key(),
        position: position.key(),
        owner: cert.owner,
        premium_usdc: quote.premium_usdc,
        cap_usdc: quote.cap_usdc,
        expiry_ts,
    });

    Ok(())
}

// ─── Settle Certificate ────────────────────────────────────────────

#[derive(Accounts)]
pub struct SettleCertificate<'info> {
    /// Anyone can trigger settlement (permissionless for liveness)
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [CERTIFICATE_SEED, position_state.position_mint.as_ref()],
        bump = certificate_state.bump,
        constraint = certificate_state.state == cert_status::ACTIVE @ LhError::NotActive,
    )]
    pub certificate_state: Account<'info, CertificateState>,

    #[account(
        mut,
        constraint = position_state.key() == certificate_state.position,
    )]
    pub position_state: Account<'info, PositionState>,

    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool_state.bump,
        constraint = pool_state.key() == certificate_state.pool,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        address = pool_state.usdc_vault,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// The certificate owner's USDC account for payout
    #[account(
        mut,
        constraint = owner_usdc.mint == pool_state.usdc_mint,
        constraint = owner_usdc.owner == certificate_state.owner,
    )]
    pub owner_usdc: Account<'info, TokenAccount>,

    /// CHECK: Pyth price feed account — validated in instruction logic
    pub pyth_price_feed: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_certificate(ctx: Context<SettleCertificate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Read certificate values before mutable borrows
    let expiry_ts = ctx.accounts.certificate_state.expiry_ts;
    let lower_barrier_e6 = ctx.accounts.certificate_state.lower_barrier_e6;
    let notional_usdc = ctx.accounts.certificate_state.notional_usdc;
    let cap_usdc = ctx.accounts.certificate_state.cap_usdc;
    let cert_owner = ctx.accounts.certificate_state.owner;
    let pool_bump = ctx.accounts.pool_state.bump;

    require!(now >= expiry_ts, LhError::TooEarly);

    // Load and validate Pyth price
    let (price_e6, conf_e6) = pyth::load_and_validate_pyth(&ctx.accounts.pyth_price_feed, now)?;

    // Conservative downside: price - confidence
    let conservative_price = price_e6.saturating_sub(conf_e6);

    // Proportional payout: min(cap, max(0, (barrier - price) * notional / barrier))
    let payout = if conservative_price >= lower_barrier_e6 {
        0u64
    } else {
        let deficit = lower_barrier_e6 - conservative_price;
        let raw_payout = (deficit as u128)
            .checked_mul(notional_usdc as u128)
            .unwrap_or(u128::MAX)
            / (lower_barrier_e6.max(1) as u128);
        let capped = raw_payout.min(cap_usdc as u128);
        capped as u64
    };

    // Pay claim via CPI before taking mutable borrows
    if payout > 0 {
        require!(
            ctx.accounts.pool_state.reserves_usdc >= payout,
            LhError::InsufficientReserves
        );

        let pool_seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: ctx.accounts.owner_usdc.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                &[pool_seeds],
            ),
            payout,
        )?;
    }

    // Now take mutable borrows for state updates
    let pool = &mut ctx.accounts.pool_state;

    if payout > 0 {
        pool.reserves_usdc = pool
            .reserves_usdc
            .checked_sub(payout)
            .ok_or(LhError::Underflow)?;

        emit!(events::ClaimPaid {
            certificate: ctx.accounts.certificate_state.key(),
            owner: cert_owner,
            payout_usdc: payout,
            settlement_price_e6: conservative_price,
        });
    } else {
        emit!(events::CertificateExpired {
            certificate: ctx.accounts.certificate_state.key(),
            settlement_price_e6: conservative_price,
        });
    }

    // Release exposure
    pool.active_cap_usdc = pool
        .active_cap_usdc
        .checked_sub(cap_usdc)
        .ok_or(LhError::Underflow)?;

    emit!(events::ExposureReleased {
        pool: pool.key(),
        cap_released: cap_usdc,
    });

    // Update certificate state
    let cert = &mut ctx.accounts.certificate_state;
    cert.state = if payout > 0 {
        cert_status::SETTLED
    } else {
        cert_status::EXPIRED
    };

    // Release position
    let position = &mut ctx.accounts.position_state;
    position.protected_by = None;

    Ok(())
}

// Pyth helpers are in crate::pyth (shared with position_escrow).
