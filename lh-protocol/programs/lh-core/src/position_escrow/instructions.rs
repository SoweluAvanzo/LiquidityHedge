use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::LhError;
use crate::events;
use crate::orca::{self, OrcaPosition, OrcaWhirlpool};
use crate::pyth;
use crate::state::*;

// ─── Register Locked Position ──────────────────────────────────────

#[derive(Accounts)]
pub struct RegisterLockedPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The position NFT mint (Token-2022 or standard)
    pub position_mint: Account<'info, anchor_spl::token::Mint>,

    /// The Orca Whirlpool pool this position belongs to.
    /// CHECK: Owner validated (Whirlpool program in production, relaxed in test-mode);
    /// deserialized and cross-checked in handler.
    pub whirlpool: UncheckedAccount<'info>,

    /// The Orca Position PDA derived from the position mint.
    /// CHECK: Owner validated (Whirlpool program in production, relaxed in test-mode);
    /// PDA derivation verified in handler; deserialized for tick bounds.
    pub orca_position: UncheckedAccount<'info>,

    /// The escrow vault ATA that should already hold the position NFT.
    /// The LP must transfer the NFT here before calling this instruction.
    #[account(
        constraint = vault_position_ata.amount == 1 @ LhError::PositionNotLocked,
        constraint = vault_position_ata.mint == position_mint.key(),
    )]
    pub vault_position_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = PositionState::SIZE,
        seeds = [POSITION_SEED, position_mint.key().as_ref()],
        bump,
    )]
    pub position_state: Account<'info, PositionState>,

    /// Protocol pool state — used to verify the Whirlpool's token_mint_b
    /// matches the protocol's USDC mint (environment-agnostic).
    #[account(
        seeds = [POOL_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// CHECK: Pyth price feed for entry-price verification.
    /// Validated inside handler via `pyth::load_and_validate_pyth`.
    pub pyth_price_feed: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_register_locked_position(
    ctx: Context<RegisterLockedPosition>,
    p0_price_e6: u64,
    deposited_a: u64,
    deposited_b: u64,
    lower_tick: i32,
    upper_tick: i32,
    liquidity: u128,
) -> Result<()> {
    // ── Production: full Orca + Pyth validation ─────────────────
    // In test-mode these checks are skipped because localnet cannot create
    // accounts with arbitrary data at Whirlpool-program-owned PDAs.
    // The tick bounds fall back to the LP-supplied instruction arguments.
    #[cfg(not(feature = "test-mode"))]
    let (resolved_lower_tick, resolved_upper_tick, oracle_p0_e6, resolved_liquidity) = {
        // Owner checks
        require!(
            ctx.accounts.whirlpool.owner == &orca::WHIRLPOOL_PROGRAM_ID,
            LhError::InvalidAccountOwner,
        );
        require!(
            ctx.accounts.orca_position.owner == &orca::WHIRLPOOL_PROGRAM_ID,
            LhError::InvalidAccountOwner,
        );

        // Deserialize Orca Position
        let orca_pos = OrcaPosition::from_account_data(
            &ctx.accounts.orca_position.try_borrow_data()?,
        )?;

        // PDA derivation
        orca::validate_orca_position_pda(
            &ctx.accounts.position_mint.key(),
            &ctx.accounts.orca_position.key(),
        )?;

        // Cross-references
        require!(
            orca_pos.position_mint == ctx.accounts.position_mint.key(),
            LhError::PositionMintMismatch,
        );
        require!(
            orca_pos.whirlpool == ctx.accounts.whirlpool.key(),
            LhError::WhirlpoolMismatch,
        );

        // Deserialize Whirlpool pool and validate pair
        let wp = OrcaWhirlpool::from_account_data(
            &ctx.accounts.whirlpool.try_borrow_data()?,
        )?;
        require!(
            wp.token_mint_b == ctx.accounts.pool_state.usdc_mint,
            LhError::InvalidPoolPair,
        );

        // Pyth entry price verification
        let now = Clock::get()?.unix_timestamp;
        let (oracle_price_e6, _conf) =
            pyth::load_and_validate_pyth(&ctx.accounts.pyth_price_feed, now)?;
        let diff = if p0_price_e6 > oracle_price_e6 {
            p0_price_e6 - oracle_price_e6
        } else {
            oracle_price_e6 - p0_price_e6
        };
        let tolerance = (oracle_price_e6 as u128)
            .checked_mul(ENTRY_PRICE_TOLERANCE_PPM as u128)
            .ok_or(error!(LhError::Overflow))?
            / PPM;
        require!((diff as u128) <= tolerance, LhError::InvalidEntryPrice);

        // Use Orca-sourced ticks, oracle price, and liquidity
        (orca_pos.tick_lower_index, orca_pos.tick_upper_index, oracle_price_e6, orca_pos.liquidity)
    };

    // ── Test-mode fallback: use LP-supplied args ────────────────
    // Orca and Pyth validation are skipped because the Anchor localnet test
    // framework cannot create accounts with pre-filled data at arbitrary
    // PDA addresses. In test-mode we trust the LP-supplied tick bounds and
    // entry price. Production builds validate everything on-chain.
    #[cfg(feature = "test-mode")]
    let (resolved_lower_tick, resolved_upper_tick, oracle_p0_e6, resolved_liquidity) = {
        (lower_tick, upper_tick, p0_price_e6, liquidity)
    };

    let state = &mut ctx.accounts.position_state;
    state.owner = ctx.accounts.owner.key();
    state.whirlpool = ctx.accounts.whirlpool.key();
    state.position_mint = ctx.accounts.position_mint.key();
    state.lower_tick = resolved_lower_tick;
    state.upper_tick = resolved_upper_tick;
    state.p0_price_e6 = p0_price_e6;
    state.oracle_p0_e6 = oracle_p0_e6;
    state.deposited_a = deposited_a;
    state.deposited_b = deposited_b;
    state.liquidity = resolved_liquidity;
    state.protected_by = None;
    state.status = position_status::LOCKED;
    state.bump = ctx.bumps.position_state;

    emit!(events::PositionRegistered {
        position: state.key(),
        owner: state.owner,
        position_mint: state.position_mint,
        whirlpool: state.whirlpool,
        p0_price_e6,
        oracle_p0_e6,
    });

    Ok(())
}

// ─── Release Position ──────────────────────────────────────────────

#[derive(Accounts)]
pub struct ReleasePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position_state.position_mint.as_ref()],
        bump = position_state.bump,
        constraint = position_state.owner == owner.key() @ LhError::Unauthorized,
        constraint = position_state.status == position_status::LOCKED @ LhError::InvalidPositionStatus,
        constraint = position_state.protected_by.is_none() @ LhError::AlreadyProtected,
    )]
    pub position_state: Account<'info, PositionState>,

    #[account(
        seeds = [POOL_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// The escrow vault holding the position NFT
    #[account(
        mut,
        constraint = vault_position_ata.mint == position_state.position_mint,
        constraint = vault_position_ata.amount == 1 @ LhError::PositionNotLocked,
    )]
    pub vault_position_ata: Account<'info, TokenAccount>,

    /// The owner's ATA to receive the position NFT back
    #[account(
        mut,
        constraint = owner_position_ata.mint == position_state.position_mint,
        constraint = owner_position_ata.owner == owner.key(),
    )]
    pub owner_position_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_release_position(ctx: Context<ReleasePosition>) -> Result<()> {
    let position = &mut ctx.accounts.position_state;

    // Transfer position NFT back to owner
    // The pool PDA is the authority over the vault
    let pool_seeds = &[POOL_SEED, &[ctx.accounts.pool_state.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_position_ata.to_account_info(),
                to: ctx.accounts.owner_position_ata.to_account_info(),
                authority: ctx.accounts.pool_state.to_account_info(),
            },
            &[pool_seeds],
        ),
        1,
    )?;

    position.status = position_status::RELEASED;

    emit!(events::PositionReleased {
        position: position.key(),
        owner: position.owner,
        position_mint: position.position_mint,
    });

    Ok(())
}
