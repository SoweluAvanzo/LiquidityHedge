use anchor_lang::prelude::*;

#[account]
pub struct PoolState {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub share_mint: Pubkey,
    pub reserves_usdc: u64,
    pub active_cap_usdc: u64,
    pub total_shares: u64,
    pub u_max_bps: u16,
    pub bump: u8,
    pub vault_bump: u8,
    pub share_mint_bump: u8,
}

impl PoolState {
    pub const SIZE: usize = 8  // discriminator
        + 32  // admin
        + 32  // usdc_mint
        + 32  // usdc_vault
        + 32  // share_mint
        + 8   // reserves_usdc
        + 8   // active_cap_usdc
        + 8   // total_shares
        + 2   // u_max_bps
        + 1   // bump
        + 1   // vault_bump
        + 1;  // share_mint_bump
}

#[account]
pub struct PositionState {
    pub owner: Pubkey,
    pub whirlpool: Pubkey,
    pub position_mint: Pubkey,
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub p0_price_e6: u64,
    pub oracle_p0_e6: u64,
    pub deposited_a: u64,
    pub deposited_b: u64,
    pub liquidity: u128,
    pub protected_by: Option<Pubkey>,
    pub status: u8,
    pub bump: u8,
}

impl PositionState {
    pub const SIZE: usize = 8  // discriminator
        + 32  // owner
        + 32  // whirlpool
        + 32  // position_mint
        + 4   // lower_tick
        + 4   // upper_tick
        + 8   // p0_price_e6
        + 8   // oracle_p0_e6
        + 8   // deposited_a
        + 8   // deposited_b
        + 16  // liquidity (u128)
        + 33  // protected_by (Option<Pubkey>: 1 tag + 32 key)
        + 1   // status
        + 1;  // bump
}

/// Position status values
pub mod position_status {
    pub const LOCKED: u8 = 1;
    pub const RELEASED: u8 = 2;
    pub const CLOSED: u8 = 3;
}

#[account]
pub struct CertificateState {
    pub owner: Pubkey,
    pub position: Pubkey,
    pub pool: Pubkey,
    pub template_id: u16,
    pub premium_usdc: u64,
    pub cap_usdc: u64,
    pub lower_barrier_e6: u64,
    pub notional_usdc: u64,
    pub expiry_ts: i64,
    pub state: u8,
    pub nft_mint: Pubkey,
    pub bump: u8,
}

impl CertificateState {
    pub const SIZE: usize = 8  // discriminator
        + 32  // owner
        + 32  // position
        + 32  // pool
        + 2   // template_id
        + 8   // premium_usdc
        + 8   // cap_usdc
        + 8   // lower_barrier_e6
        + 8   // notional_usdc
        + 8   // expiry_ts
        + 1   // state
        + 32  // nft_mint
        + 1;  // bump
}

/// Certificate state values
pub mod cert_status {
    pub const CREATED: u8 = 0;
    pub const ACTIVE: u8 = 1;
    pub const SETTLED: u8 = 2;
    pub const EXPIRED: u8 = 3;
}

#[account]
pub struct RegimeSnapshot {
    pub sigma_ppm: u64,
    pub sigma_ma_ppm: u64,
    pub stress_flag: bool,
    pub carry_bps_per_day: u32,
    pub updated_ts: i64,
    pub signer: Pubkey,
    pub bump: u8,
}

impl RegimeSnapshot {
    pub const SIZE: usize = 8  // discriminator
        + 8   // sigma_ppm
        + 8   // sigma_ma_ppm
        + 1   // stress_flag
        + 4   // carry_bps_per_day
        + 8   // updated_ts
        + 32  // signer
        + 1;  // bump
}

#[account]
pub struct TemplateConfig {
    pub template_id: u16,
    pub tenor_seconds: u64,
    pub width_bps: u16,
    pub severity_ppm: u64,
    pub premium_floor_usdc: u64,
    pub premium_ceiling_usdc: u64,
    pub active: bool,
    pub bump: u8,
}

impl TemplateConfig {
    pub const SIZE: usize = 8  // discriminator
        + 2   // template_id
        + 8   // tenor_seconds
        + 2   // width_bps
        + 8   // severity_ppm
        + 8   // premium_floor_usdc
        + 8   // premium_ceiling_usdc
        + 1   // active
        + 1;  // bump
}
