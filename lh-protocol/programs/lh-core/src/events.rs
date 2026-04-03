use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub u_max_bps: u16,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub usdc_amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub withdrawer: Pubkey,
    pub usdc_amount: u64,
    pub shares_burned: u64,
}

#[event]
pub struct PositionRegistered {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub position_mint: Pubkey,
    pub whirlpool: Pubkey,
    pub p0_price_e6: u64,
    pub oracle_p0_e6: u64,
}

#[event]
pub struct PositionReleased {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub position_mint: Pubkey,
}

#[event]
pub struct QuoteComputed {
    pub position: Pubkey,
    pub premium_usdc: u64,
    pub cap_usdc: u64,
    pub expected_payout_usdc: u64,
}

#[event]
pub struct CertificateActivated {
    pub certificate: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub premium_usdc: u64,
    pub cap_usdc: u64,
    pub expiry_ts: i64,
}

#[event]
pub struct ClaimPaid {
    pub certificate: Pubkey,
    pub owner: Pubkey,
    pub payout_usdc: u64,
    pub settlement_price_e6: u64,
}

#[event]
pub struct CertificateExpired {
    pub certificate: Pubkey,
    pub settlement_price_e6: u64,
}

#[event]
pub struct ExposureReleased {
    pub pool: Pubkey,
    pub cap_released: u64,
}

#[event]
pub struct RegimeUpdated {
    pub regime: Pubkey,
    pub sigma_ppm: u64,
    pub stress_flag: bool,
    pub updated_ts: i64,
}

#[event]
pub struct TemplateCreated {
    pub template: Pubkey,
    pub template_id: u16,
    pub tenor_seconds: u64,
}
