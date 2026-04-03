use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::LhError;
use crate::events;
use crate::math::integer_sqrt;
use crate::state::*;

// ─── Update Regime Snapshot ────────────────────────────────────────

#[derive(Accounts)]
pub struct UpdateRegimeSnapshot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [POOL_SEED],
        bump = pool_state.bump,
        constraint = pool_state.admin == authority.key() @ LhError::Unauthorized,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init_if_needed,
        payer = authority,
        space = RegimeSnapshot::SIZE,
        seeds = [REGIME_SEED, pool_state.key().as_ref()],
        bump,
    )]
    pub regime_snapshot: Account<'info, RegimeSnapshot>,

    pub system_program: Program<'info, System>,
}

pub fn handle_update_regime_snapshot(
    ctx: Context<UpdateRegimeSnapshot>,
    sigma_ppm: u64,
    sigma_ma_ppm: u64,
    stress_flag: bool,
    carry_bps_per_day: u32,
) -> Result<()> {
    // Validate regime parameters are within sane bounds
    // sigma: 0.1% to 500% annualized (1_000 to 5_000_000 PPM)
    require!(
        sigma_ppm >= 1_000 && sigma_ppm <= 5_000_000,
        LhError::InvalidRegimeParams
    );
    require!(
        sigma_ma_ppm >= 1_000 && sigma_ma_ppm <= 5_000_000,
        LhError::InvalidRegimeParams
    );
    // carry: max 10%/day (1_000 bps)
    require!(carry_bps_per_day <= 1_000, LhError::InvalidRegimeParams);

    let regime = &mut ctx.accounts.regime_snapshot;
    regime.sigma_ppm = sigma_ppm;
    regime.sigma_ma_ppm = sigma_ma_ppm;
    regime.stress_flag = stress_flag;
    regime.carry_bps_per_day = carry_bps_per_day;
    regime.updated_ts = Clock::get()?.unix_timestamp;
    regime.signer = ctx.accounts.authority.key();
    regime.bump = ctx.bumps.regime_snapshot;

    emit!(events::RegimeUpdated {
        regime: regime.key(),
        sigma_ppm,
        stress_flag,
        updated_ts: regime.updated_ts,
    });

    Ok(())
}

// ─── Create Template ───────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(template_id: u16)]
pub struct CreateTemplate<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [POOL_SEED],
        bump = pool_state.bump,
        constraint = pool_state.admin == admin.key() @ LhError::Unauthorized,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init,
        payer = admin,
        space = TemplateConfig::SIZE,
        seeds = [TEMPLATE_SEED, &template_id.to_le_bytes()],
        bump,
    )]
    pub template: Account<'info, TemplateConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_template(
    ctx: Context<CreateTemplate>,
    template_id: u16,
    tenor_days: u32,
    width_bps: u16,
    severity_ppm: u64,
    premium_floor_usdc: u64,
    premium_ceiling_usdc: u64,
) -> Result<()> {
    require!(tenor_days > 0, LhError::InvalidTemplate);
    require!(width_bps > 0, LhError::InvalidTemplate);
    require!(severity_ppm <= PPM as u64, LhError::InvalidTemplate);
    require!(
        premium_floor_usdc <= premium_ceiling_usdc,
        LhError::InvalidTemplate
    );

    let template = &mut ctx.accounts.template;
    template.template_id = template_id;
    template.tenor_days = tenor_days;
    template.width_bps = width_bps;
    template.severity_ppm = severity_ppm;
    template.premium_floor_usdc = premium_floor_usdc;
    template.premium_ceiling_usdc = premium_ceiling_usdc;
    template.active = true;
    template.bump = ctx.bumps.template;

    emit!(events::TemplateCreated {
        template: template.key(),
        template_id,
        tenor_days,
    });

    Ok(())
}

// ─── Quote Computation ─────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct QuoteBreakdown {
    pub premium_usdc: u64,
    pub cap_usdc: u64,
    pub expected_payout_usdc: u64,
    pub capital_charge_usdc: u64,
    pub adverse_selection_usdc: u64,
    pub replication_cost_usdc: u64,
}

pub fn compute_quote(
    cap_usdc: u64,
    template: &TemplateConfig,
    pool: &PoolState,
    regime: &RegimeSnapshot,
) -> Result<QuoteBreakdown> {
    let reserves = (pool.reserves_usdc.max(1)) as u128;
    let active = pool.active_cap_usdc as u128;
    let cap = cap_usdc as u128;
    let u_after_ppm = ((active + cap) * PPM) / reserves;
    let u_max_ppm = (pool.u_max_bps as u128) * 100u128;

    require!(u_after_ppm <= u_max_ppm, LhError::InsufficientHeadroom);

    let sigma_ppm = regime.sigma_ppm as u128;
    let tenor_ppm = ((template.tenor_days as u128) * PPM) / 365u128;
    let sqrt_t_ppm = integer_sqrt(tenor_ppm * PPM);
    let width_ppm = (template.width_bps as u128) * 100u128;

    // p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
    let mut p_hit_ppm = (900_000u128)
        .checked_mul(sigma_ppm)
        .ok_or(LhError::Overflow)?
        .checked_mul(sqrt_t_ppm)
        .ok_or(LhError::Overflow)?
        / PPM
        / width_ppm.max(1);
    if p_hit_ppm > PPM {
        p_hit_ppm = PPM;
    }

    let severity_ppm = template.severity_ppm as u128;

    // E[Payout] = Cap * p_hit * severity / PPM^2
    let expected_payout = cap
        .checked_mul(p_hit_ppm)
        .ok_or(LhError::Overflow)?
        .checked_mul(severity_ppm)
        .ok_or(LhError::Overflow)?
        / PPM
        / PPM;

    // C_cap = Cap * (U_after / PPM)^2 / 5
    let capital_charge = cap
        .checked_mul(u_after_ppm)
        .ok_or(LhError::Overflow)?
        .checked_mul(u_after_ppm)
        .ok_or(LhError::Overflow)?
        / PPM
        / PPM
        / 5u128;

    // C_adv = Cap/10 if stress flag, else 0
    let adverse = if regime.stress_flag {
        cap / 10u128
    } else {
        0
    };

    // C_rep = Cap * carry_bps * tenor_days / 10_000 / 100
    let replication = cap
        .checked_mul(regime.carry_bps_per_day as u128)
        .ok_or(LhError::Overflow)?
        .checked_mul(template.tenor_days as u128)
        .ok_or(LhError::Overflow)?
        / BPS
        / 100u128;

    let mut premium = expected_payout + capital_charge + adverse + replication;

    // Clamp to [floor, ceiling] from template
    let floor = template.premium_floor_usdc as u128;
    let ceiling = template.premium_ceiling_usdc as u128;
    if premium < floor {
        premium = floor;
    }
    if premium > ceiling {
        premium = ceiling;
    }

    Ok(QuoteBreakdown {
        premium_usdc: premium as u64,
        cap_usdc,
        expected_payout_usdc: expected_payout as u64,
        capital_charge_usdc: capital_charge as u64,
        adverse_selection_usdc: adverse as u64,
        replication_cost_usdc: replication as u64,
    })
}
