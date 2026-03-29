use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::LhError;
use crate::events;
use crate::state::*;

// ─── Initialize Pool ───────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = PoolState::SIZE,
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = pool_state,
        seeds = [POOL_VAULT_SEED],
        bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = pool_state,
        seeds = [SHARE_MINT_SEED],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize_pool(ctx: Context<InitializePool>, u_max_bps: u16) -> Result<()> {
    let pool = &mut ctx.accounts.pool_state;
    pool.admin = ctx.accounts.admin.key();
    pool.usdc_mint = ctx.accounts.usdc_mint.key();
    pool.usdc_vault = ctx.accounts.usdc_vault.key();
    pool.share_mint = ctx.accounts.share_mint.key();
    pool.reserves_usdc = 0;
    pool.active_cap_usdc = 0;
    pool.total_shares = 0;
    pool.u_max_bps = u_max_bps;
    pool.bump = ctx.bumps.pool_state;
    pool.vault_bump = ctx.bumps.usdc_vault;
    pool.share_mint_bump = ctx.bumps.share_mint;

    emit!(events::PoolInitialized {
        pool: pool.key(),
        admin: pool.admin,
        usdc_mint: pool.usdc_mint,
        u_max_bps,
    });

    Ok(())
}

// ─── Deposit USDC ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositUsdc<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        address = pool_state.usdc_vault,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_usdc.mint == pool_state.usdc_mint,
        constraint = depositor_usdc.owner == depositor.key(),
    )]
    pub depositor_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = pool_state.share_mint,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = depositor_shares.mint == pool_state.share_mint,
        constraint = depositor_shares.owner == depositor.key(),
    )]
    pub depositor_shares: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
    require!(amount > 0, LhError::Overflow);

    // Read pool state values before CPI (avoid borrow conflicts)
    let total_shares = ctx.accounts.pool_state.total_shares;
    let reserves_usdc = ctx.accounts.pool_state.reserves_usdc;
    let pool_bump = ctx.accounts.pool_state.bump;

    // Compute shares to mint (NAV-based)
    let shares_to_mint = if total_shares == 0 || reserves_usdc == 0 {
        amount
    } else {
        (amount as u128)
            .checked_mul(total_shares as u128)
            .ok_or(LhError::Overflow)?
            .checked_div(reserves_usdc as u128)
            .ok_or(LhError::Overflow)? as u64
    };
    require!(shares_to_mint > 0, LhError::Overflow);

    // Transfer USDC from depositor to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    // Mint shares to depositor
    let pool_seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.depositor_shares.to_account_info(),
                authority: ctx.accounts.pool_state.to_account_info(),
            },
            &[pool_seeds],
        ),
        shares_to_mint,
    )?;

    // Now take mutable borrow for state updates
    let pool = &mut ctx.accounts.pool_state;
    pool.reserves_usdc = pool
        .reserves_usdc
        .checked_add(amount)
        .ok_or(LhError::Overflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares_to_mint)
        .ok_or(LhError::Overflow)?;

    emit!(events::Deposited {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        usdc_amount: amount,
        shares_minted: shares_to_mint,
    });

    Ok(())
}

// ─── Withdraw USDC ─────────────────────────────────────────────────

#[derive(Accounts)]
pub struct WithdrawUsdc<'info> {
    #[account(mut)]
    pub withdrawer: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        address = pool_state.usdc_vault,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = withdrawer_usdc.mint == pool_state.usdc_mint,
        constraint = withdrawer_usdc.owner == withdrawer.key(),
    )]
    pub withdrawer_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = pool_state.share_mint,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = withdrawer_shares.mint == pool_state.share_mint,
        constraint = withdrawer_shares.owner == withdrawer.key(),
    )]
    pub withdrawer_shares: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw_usdc(ctx: Context<WithdrawUsdc>, shares_to_burn: u64) -> Result<()> {
    require!(shares_to_burn > 0, LhError::Overflow);

    // Read pool values before CPI
    let reserves_usdc = ctx.accounts.pool_state.reserves_usdc;
    let total_shares = ctx.accounts.pool_state.total_shares;
    let active_cap_usdc = ctx.accounts.pool_state.active_cap_usdc;
    let u_max_bps = ctx.accounts.pool_state.u_max_bps;
    let pool_bump = ctx.accounts.pool_state.bump;

    // Compute USDC to return (NAV-based)
    let usdc_to_return = (shares_to_burn as u128)
        .checked_mul(reserves_usdc as u128)
        .ok_or(LhError::Overflow)?
        .checked_div(total_shares as u128)
        .ok_or(LhError::Overflow)? as u64;

    // Check utilization constraint
    let post_reserves = reserves_usdc
        .checked_sub(usdc_to_return)
        .ok_or(LhError::Underflow)?;

    if active_cap_usdc > 0 {
        let min_reserves = (active_cap_usdc as u128)
            .checked_mul(BPS)
            .ok_or(LhError::Overflow)?
            .checked_div(u_max_bps as u128)
            .ok_or(LhError::Overflow)? as u64;
        require!(
            post_reserves >= min_reserves,
            LhError::WithdrawalWouldBreachUtilization
        );
    }

    // Burn shares
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.withdrawer_shares.to_account_info(),
                authority: ctx.accounts.withdrawer.to_account_info(),
            },
        ),
        shares_to_burn,
    )?;

    // Transfer USDC from vault to withdrawer
    let pool_seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.withdrawer_usdc.to_account_info(),
                authority: ctx.accounts.pool_state.to_account_info(),
            },
            &[pool_seeds],
        ),
        usdc_to_return,
    )?;

    // Update pool state
    let pool = &mut ctx.accounts.pool_state;
    pool.reserves_usdc = post_reserves;
    pool.total_shares = pool
        .total_shares
        .checked_sub(shares_to_burn)
        .ok_or(LhError::Underflow)?;

    emit!(events::Withdrawn {
        pool: pool.key(),
        withdrawer: ctx.accounts.withdrawer.key(),
        usdc_amount: usdc_to_return,
        shares_burned: shares_to_burn,
    });

    Ok(())
}
