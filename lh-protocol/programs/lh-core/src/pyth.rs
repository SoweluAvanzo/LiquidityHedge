//! Shared Pyth oracle helpers used by both position_escrow (entry price
//! verification) and certificates (settlement).

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::LhError;

// ─── Constants ────────────────────────────────────────────────────────

/// Pyth V2 on-chain oracle program (mainnet).
pub const PYTH_PROGRAM_V2: Pubkey =
    pubkey!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

/// Pyth V2 account magic number (first 4 bytes).
const PYTH_MAGIC: u32 = 0xa1b2c3d4;

/// Pyth V2 price status: TRADING = 1.
const PYTH_STATUS_TRADING: u32 = 1;

// ─── Public API ───────────────────────────────────────────────────────

/// Load and validate a Pyth price feed account, returning `(price_e6, conf_e6)`.
///
/// Supports two modes:
/// - **Mock/test** (`data.len() < 240`): 24-byte layout `[price_e6: u64, conf_e6: u64, timestamp: i64]`
/// - **Pyth V2** (`data.len() >= 240`): full PriceAccount with magic, status, and offset-based parsing
///
/// In production (without `test-mode` feature), the V2 path also validates:
/// - Account owner is the Pyth V2 program
/// - Magic number matches
/// - Price status is TRADING
/// - Confidence is not too wide (< 5% of price)
pub fn load_and_validate_pyth(
    pyth_account: &UncheckedAccount,
    now: i64,
) -> Result<(u64, u64)> {
    let data = pyth_account.try_borrow_data()?;
    require!(data.len() >= 24, LhError::StaleOracle);

    if data.len() < 240 {
        // Mock/test mode: first 24 bytes = [price_e6: u64, conf_e6: u64, timestamp: i64]
        let price_e6 = u64::from_le_bytes(data[0..8].try_into().unwrap());
        let conf_e6 = u64::from_le_bytes(data[8..16].try_into().unwrap());

        // Staleness check: skipped in test-mode because the localnet validator
        // clock can diverge from the timestamp written by the test harness.
        #[cfg(not(feature = "test-mode"))]
        {
            let timestamp = i64::from_le_bytes(data[16..24].try_into().unwrap());
            require!(
                now - timestamp <= PYTH_MAX_STALENESS as i64,
                LhError::StaleOracle,
            );
        }

        return Ok((price_e6, conf_e6));
    }

    // ── Full Pyth V2 parsing ────────────────────────────────────

    // Owner validation (production only)
    #[cfg(not(feature = "test-mode"))]
    {
        require!(
            pyth_account.owner == &PYTH_PROGRAM_V2,
            LhError::InvalidAccountOwner,
        );
    }

    // Magic number check
    let magic = u32::from_le_bytes(
        data[0..4].try_into().unwrap(),
    );
    require!(magic == PYTH_MAGIC, LhError::StaleOracle);

    // Price status at offset 172 must be TRADING (1)
    let status = u32::from_le_bytes(
        data[172..176].try_into().unwrap(),
    );
    require!(status == PYTH_STATUS_TRADING, LhError::StaleOracle);

    // Price fields at known Pyth V2 PriceAccount offsets
    let price = i64::from_le_bytes(data[208..216].try_into().unwrap());
    let conf = u64::from_le_bytes(data[216..224].try_into().unwrap());
    let expo = i32::from_le_bytes(data[224..228].try_into().unwrap());
    let timestamp = i64::from_le_bytes(data[232..240].try_into().unwrap());

    require!(
        now - timestamp <= PYTH_MAX_STALENESS as i64,
        LhError::StaleOracle,
    );
    require!(price > 0, LhError::StaleOracle);

    let price_e6 = normalize_to_e6(price, expo)?;
    let conf_e6 = normalize_to_e6(conf as i64, expo)?;

    // Confidence bounds: reject if confidence > 5% of price
    let max_conf = (price_e6 as u128)
        .checked_mul(PYTH_MAX_CONFIDENCE_PPM as u128)
        .ok_or(error!(LhError::Overflow))?
        / PPM;
    require!(
        (conf_e6 as u128) <= max_conf,
        LhError::InvalidConfidence,
    );

    Ok((price_e6, conf_e6))
}

/// Normalize a Pyth value with arbitrary exponent to 6 decimal places (e6).
pub fn normalize_to_e6(value: i64, expo: i32) -> Result<u64> {
    let target_expo: i32 = -6;
    let shift = target_expo - expo;

    let result = if shift >= 0 {
        (value.unsigned_abs() as u128) / 10u128.pow(shift as u32)
    } else {
        (value.unsigned_abs() as u128) * 10u128.pow((-shift) as u32)
    };

    Ok(result as u64)
}
