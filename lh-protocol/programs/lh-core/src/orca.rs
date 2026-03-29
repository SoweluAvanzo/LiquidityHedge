//! Read-only deserialization of Orca Whirlpool accounts.
//!
//! We only need to READ position and pool data for validation — no CPI into
//! the Whirlpool program. Manual byte parsing avoids dependency conflicts
//! with whirlpool-cpi crates.
//!
//! Layouts validated against the reference implementation at
//! `test_deployment_v2/app/chain/orca_client.py` (lines 633-819).

use anchor_lang::prelude::*;

use crate::errors::LhError;

// ─── Constants ────────────────────────────────────────────────────────

/// Orca Whirlpool program ID (mainnet / devnet).
pub const WHIRLPOOL_PROGRAM_ID: Pubkey =
    pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

/// Native SOL mint.
pub const SOL_MINT: Pubkey =
    pubkey!("So11111111111111111111111111111111111111112");

// ─── Orca Position ────────────────────────────────────────────────────

/// Anchor discriminator for the Orca `Position` account.
const POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

/// Minimum account data length for an Orca Position (through tick_upper_index).
const POSITION_MIN_LEN: usize = 96;

/// Read-only view of an Orca Whirlpool Position account.
///
/// ```text
/// Offset  Size  Field
/// ──────────────────────────
///   0       8   discriminator
///   8      32   whirlpool
///  40      32   position_mint
///  72      16   liquidity (u128)
///  88       4   tick_lower_index (i32)
///  92       4   tick_upper_index (i32)
/// ```
pub struct OrcaPosition {
    pub whirlpool: Pubkey,
    pub position_mint: Pubkey,
    pub liquidity: u128,
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
}

impl OrcaPosition {
    pub fn from_account_data(data: &[u8]) -> Result<Self> {
        require!(data.len() >= POSITION_MIN_LEN, LhError::InvalidOrcaPosition);
        require!(
            data[0..8] == POSITION_DISCRIMINATOR,
            LhError::InvalidOrcaPosition,
        );

        let whirlpool = Pubkey::try_from(&data[8..40])
            .map_err(|_| error!(LhError::InvalidOrcaPosition))?;
        let position_mint = Pubkey::try_from(&data[40..72])
            .map_err(|_| error!(LhError::InvalidOrcaPosition))?;
        let liquidity = u128::from_le_bytes(
            data[72..88].try_into().map_err(|_| error!(LhError::InvalidOrcaPosition))?,
        );
        let tick_lower_index = i32::from_le_bytes(
            data[88..92].try_into().map_err(|_| error!(LhError::InvalidOrcaPosition))?,
        );
        let tick_upper_index = i32::from_le_bytes(
            data[92..96].try_into().map_err(|_| error!(LhError::InvalidOrcaPosition))?,
        );

        Ok(Self {
            whirlpool,
            position_mint,
            liquidity,
            tick_lower_index,
            tick_upper_index,
        })
    }
}

// ─── Orca Whirlpool ───────────────────────────────────────────────────

/// Anchor discriminator for the Orca `Whirlpool` account.
const WHIRLPOOL_DISCRIMINATOR: [u8; 8] = [63, 149, 209, 12, 225, 128, 99, 9];

/// Minimum account data length for an Orca Whirlpool (through token_mint_b + 32).
const WHIRLPOOL_MIN_LEN: usize = 213 + 32; // 245

/// Read-only view of an Orca Whirlpool pool account.
///
/// ```text
/// Offset  Size  Field
/// ──────────────────────────
///   0       8   discriminator
///  41       2   tick_spacing (u16)
///  65      16   sqrt_price (u128)
///  81       4   tick_current_index (i32)
/// 101      32   token_mint_a
/// 181      32   token_mint_b
/// ```
pub struct OrcaWhirlpool {
    pub tick_spacing: u16,
    pub sqrt_price: u128,
    pub tick_current_index: i32,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
}

impl OrcaWhirlpool {
    pub fn from_account_data(data: &[u8]) -> Result<Self> {
        require!(data.len() >= WHIRLPOOL_MIN_LEN, LhError::InvalidOrcaWhirlpool);
        require!(
            data[0..8] == WHIRLPOOL_DISCRIMINATOR,
            LhError::InvalidOrcaWhirlpool,
        );

        let tick_spacing = u16::from_le_bytes(
            data[41..43].try_into().map_err(|_| error!(LhError::InvalidOrcaWhirlpool))?,
        );
        let sqrt_price = u128::from_le_bytes(
            data[65..81].try_into().map_err(|_| error!(LhError::InvalidOrcaWhirlpool))?,
        );
        let tick_current_index = i32::from_le_bytes(
            data[81..85].try_into().map_err(|_| error!(LhError::InvalidOrcaWhirlpool))?,
        );
        let token_mint_a = Pubkey::try_from(&data[101..133])
            .map_err(|_| error!(LhError::InvalidOrcaWhirlpool))?;
        let token_mint_b = Pubkey::try_from(&data[181..213])
            .map_err(|_| error!(LhError::InvalidOrcaWhirlpool))?;

        Ok(Self {
            tick_spacing,
            sqrt_price,
            tick_current_index,
            token_mint_a,
            token_mint_b,
        })
    }
}

// ─── PDA helpers ──────────────────────────────────────────────────────

/// Verify that `expected_pda` is the canonical Orca Position PDA for `position_mint`.
///
/// Seeds: `["position", position_mint]` under `WHIRLPOOL_PROGRAM_ID`.
pub fn validate_orca_position_pda(
    position_mint: &Pubkey,
    expected_pda: &Pubkey,
) -> Result<()> {
    let (derived, _bump) = Pubkey::find_program_address(
        &[b"position", position_mint.as_ref()],
        &WHIRLPOOL_PROGRAM_ID,
    );
    require!(derived == *expected_pda, LhError::InvalidPositionPda);
    Ok(())
}
