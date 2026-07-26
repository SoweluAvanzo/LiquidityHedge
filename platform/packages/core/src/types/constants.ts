/**
 * Scaling constants, oracle/validation thresholds, and protocol defaults.
 * All values below are *governance parameters* in the PoC and can be
 * overridden per-instance via `PoolInitConfig` (see `config/templates.ts`).
 */

// ---------------------------------------------------------------------------
// Scaling constants
// ---------------------------------------------------------------------------

/** Parts per million — used for probabilities, ratios, volatility */
export const PPM = 1_000_000;
export const PPM_BI = BigInt(PPM);

/** Basis points — used for rates, utilization, width */
export const BPS = 10_000;
export const BPS_BI = BigInt(BPS);

/** Q64 fixed-point multiplier (2^64) — used for sqrt-price representation */
export const Q64 = BigInt(1) << BigInt(64);

// ---------------------------------------------------------------------------
// Oracle & validation thresholds
// ---------------------------------------------------------------------------

/** Maximum Pyth price feed staleness (seconds) */
export const PYTH_MAX_STALENESS_S = 30;

/** Entry price tolerance vs oracle (PPM): 50_000 = 5% */
export const ENTRY_PRICE_TOLERANCE_PPM = 50_000;

/** Maximum acceptable Pyth confidence interval (PPM): 50_000 = 5% */
export const PYTH_MAX_CONFIDENCE_PPM = 50_000;

/** Maximum age of a RegimeSnapshot before it is considered stale (seconds) */
export const REGIME_MAX_AGE_S = 900;

// ---------------------------------------------------------------------------
// Protocol defaults
// ---------------------------------------------------------------------------

/** Minimum volatility markup (m_vol floor) */
export const DEFAULT_MARKUP_FLOOR = 1.05;

/** Fee-split rate: share of LP trading fees transferred to RT at settlement */
export const DEFAULT_FEE_SPLIT_RATE = 0.1;

/** Expected daily LP fee rate (fraction of position value) */
export const DEFAULT_EXPECTED_DAILY_FEE = 0.005;

/** Default premium floor in micro-USDC ($1.50) — governance parameter */
export const DEFAULT_PREMIUM_FLOOR_USDC = 1_500_000;

/** Default protocol treasury fee on premiums (BPS): 150 = 1.5% */
export const DEFAULT_PROTOCOL_FEE_BPS = 150;

/** Default maximum utilization (BPS): 3000 = 30% */
export const DEFAULT_U_MAX_BPS = 3_000;

/** Default severity for heuristic fair-value proxy (PPM) */
export const DEFAULT_SEVERITY_PPM = 380_000;

/** Seconds in one year (365 days) */
export const SECONDS_PER_YEAR = 365 * 86_400;
