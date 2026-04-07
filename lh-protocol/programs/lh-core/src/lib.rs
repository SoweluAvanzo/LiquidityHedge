use anchor_lang::prelude::*;

pub mod certificates;
pub mod constants;
pub mod errors;
pub mod events;
pub mod math;
pub mod orca;
pub mod pool;
pub mod position_escrow;
pub mod pricing;
pub mod pyth;
pub mod state;

use certificates::*;
use pool::*;
use position_escrow::*;
use pricing::*;

declare_id!("CuTEecNBQTu1Joaa7ZikePChbGLstvYKNuW3KQEwhfdA");

#[program]
pub mod lh_core {
    use super::*;

    // ─── Pool ──────────────────────────────────────────────────────

    pub fn initialize_pool(ctx: Context<InitializePool>, u_max_bps: u16) -> Result<()> {
        pool::handle_initialize_pool(ctx, u_max_bps)
    }

    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
        pool::handle_deposit_usdc(ctx, amount)
    }

    pub fn withdraw_usdc(ctx: Context<WithdrawUsdc>, shares: u64) -> Result<()> {
        pool::handle_withdraw_usdc(ctx, shares)
    }

    // ─── Position Escrow ───────────────────────────────────────────

    pub fn register_locked_position(
        ctx: Context<RegisterLockedPosition>,
        p0_price_e6: u64,
        deposited_a: u64,
        deposited_b: u64,
        lower_tick: i32,
        upper_tick: i32,
        liquidity: u128,
    ) -> Result<()> {
        position_escrow::handle_register_locked_position(
            ctx,
            p0_price_e6,
            deposited_a,
            deposited_b,
            lower_tick,
            upper_tick,
            liquidity,
        )
    }

    pub fn release_position(ctx: Context<ReleasePosition>) -> Result<()> {
        position_escrow::handle_release_position(ctx)
    }

    // ─── Pricing ───────────────────────────────────────────────────

    pub fn update_regime_snapshot(
        ctx: Context<UpdateRegimeSnapshot>,
        sigma_ppm: u64,
        sigma_ma_ppm: u64,
        stress_flag: bool,
        carry_bps_per_day: u32,
    ) -> Result<()> {
        pricing::handle_update_regime_snapshot(
            ctx,
            sigma_ppm,
            sigma_ma_ppm,
            stress_flag,
            carry_bps_per_day,
        )
    }

    pub fn create_template(
        ctx: Context<CreateTemplate>,
        template_id: u16,
        tenor_seconds: u64,
        width_bps: u16,
        severity_ppm: u64,
        premium_floor_usdc: u64,
        premium_ceiling_usdc: u64,
    ) -> Result<()> {
        pricing::handle_create_template(
            ctx,
            template_id,
            tenor_seconds,
            width_bps,
            severity_ppm,
            premium_floor_usdc,
            premium_ceiling_usdc,
        )
    }

    // ─── Certificates ──────────────────────────────────────────────

    pub fn buy_certificate(
        ctx: Context<BuyCertificate>,
        cap_usdc: u64,
        lower_barrier_e6: u64,
        notional_usdc: u64,
    ) -> Result<()> {
        certificates::handle_buy_certificate(ctx, cap_usdc, lower_barrier_e6, notional_usdc)
    }

    pub fn settle_certificate(ctx: Context<SettleCertificate>) -> Result<()> {
        certificates::handle_settle_certificate(ctx)
    }
}
