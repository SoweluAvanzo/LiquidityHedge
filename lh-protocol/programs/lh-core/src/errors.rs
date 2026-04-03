use anchor_lang::prelude::*;

#[error_code]
pub enum LhError {
    #[msg("Position NFT not found in escrow vault")]
    PositionNotLocked,

    #[msg("Position already has an active certificate")]
    AlreadyProtected,

    #[msg("Pool utilization would exceed maximum after this operation")]
    InsufficientHeadroom,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Arithmetic underflow")]
    Underflow,

    #[msg("Certificate is not in active state")]
    NotActive,

    #[msg("Certificate has not reached expiry")]
    TooEarly,

    #[msg("Oracle price feed is stale")]
    StaleOracle,

    #[msg("Oracle confidence interval too wide")]
    InvalidConfidence,

    #[msg("Withdrawal would breach utilization limit")]
    WithdrawalWouldBreachUtilization,

    #[msg("Reported entry price deviates too far from oracle")]
    InvalidEntryPrice,

    #[msg("Regime snapshot is stale")]
    StaleRegime,

    #[msg("Invalid position status for this operation")]
    InvalidPositionStatus,

    #[msg("Certificate already settled or expired")]
    AlreadySettled,

    #[msg("Unauthorized signer")]
    Unauthorized,

    #[msg("Template is not active")]
    TemplateInactive,

    #[msg("Invalid template parameters")]
    InvalidTemplate,

    #[msg("Insufficient pool reserves for payout")]
    InsufficientReserves,

    #[msg("Invalid Orca Position account data")]
    InvalidOrcaPosition,

    #[msg("Invalid Orca Whirlpool account data")]
    InvalidOrcaWhirlpool,

    #[msg("Position mint does not match Orca position")]
    PositionMintMismatch,

    #[msg("Whirlpool does not match Orca position")]
    WhirlpoolMismatch,

    #[msg("Pool is not SOL/USDC")]
    InvalidPoolPair,

    #[msg("Orca Position PDA derivation mismatch")]
    InvalidPositionPda,

    #[msg("Account owner is not the expected program")]
    InvalidAccountOwner,

    #[msg("Lower barrier must be greater than zero")]
    InvalidBarrier,

    #[msg("Notional must be greater than zero")]
    InvalidNotional,

    #[msg("Regime parameters out of acceptable range")]
    InvalidRegimeParams,
}
