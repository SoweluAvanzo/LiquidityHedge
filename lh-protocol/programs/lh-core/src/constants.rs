pub const POOL_SEED: &[u8] = b"pool";
pub const POSITION_SEED: &[u8] = b"position";
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
pub const REGIME_SEED: &[u8] = b"regime";
pub const TEMPLATE_SEED: &[u8] = b"template";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";

/// Maximum staleness for Pyth price feeds (seconds)
pub const PYTH_MAX_STALENESS: u64 = 30;

/// Maximum deviation between LP-reported and oracle price (5% = 50_000 ppm)
pub const ENTRY_PRICE_TOLERANCE_PPM: u64 = 50_000;

/// PPM = parts per million (1_000_000 = 100%)
pub const PPM: u128 = 1_000_000;

/// BPS = basis points (10_000 = 100%)
pub const BPS: u128 = 10_000;

/// Maximum confidence interval as fraction of price (5% = 50_000 ppm)
pub const PYTH_MAX_CONFIDENCE_PPM: u64 = 50_000;
