/**
 * Liquidity Hedge Protocol — Type Definitions & Constants
 *
 * Canonical reference for all protocol types, state structures,
 * and scaling constants used across the off-chain emulator.
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
export const DEFAULT_FEE_SPLIT_RATE = 0.10;

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

// ---------------------------------------------------------------------------
// Pool state — the USDC protection pool underwritten by Risk Takers
// ---------------------------------------------------------------------------

export interface PoolState {
  /** Total USDC reserves held in the pool vault (micro-USDC) */
  reservesUsdc: number;

  /** Total outstanding share tokens */
  totalShares: number;

  /** Sum of capUsdc across all active certificates (micro-USDC) */
  activeCapUsdc: number;

  /** Maximum utilization ratio (BPS): activeCapUsdc / reservesUsdc <= uMaxBps / BPS */
  uMaxBps: number;

  /** Minimum volatility markup m_vol (e.g. 1.05) */
  markupFloor: number;

  /** Fee-split rate y in [0, 1]: share of LP fees transferred to RT */
  feeSplitRate: number;

  /** Expected daily LP fee rate (fraction of position value, e.g. 0.005) */
  expectedDailyFee: number;

  /**
   * Premium floor P_floor in micro-USDC — governance parameter.
   * The premium is: max(P_floor, FV * m_vol - y * E[F]).
   * Governance must set P_floor >= r_opp * Cap * T for RT participation.
   */
  premiumFloorUsdc: number;

  /** Protocol treasury fee on premiums (BPS) */
  protocolFeeBps: number;

  /** PDA bump seed */
  bump: number;
}

// ---------------------------------------------------------------------------
// Position state — escrowed Orca Whirlpool CL position
// ---------------------------------------------------------------------------

export enum PositionStatus {
  /** Position NFT is locked in protocol escrow */
  Locked = 1,
  /** Position released back to owner (certificate settled/expired) */
  Released = 2,
  /** Position closed (NFT burned or withdrawn) */
  Closed = 3,
}

export interface PositionState {
  /** Mint address of the Orca position NFT */
  positionMint: string;

  /** Owner (LP) wallet address */
  owner: string;

  /** SOL/USDC price at position registration (micro-USD, 6 decimals) */
  entryPriceE6: number;

  /** Lower tick of the CL position */
  lowerTick: number;

  /** Upper tick of the CL position */
  upperTick: number;

  /** Liquidity parameter L of the CL position */
  liquidity: bigint;

  /** Position value at entry in micro-USDC */
  entryValueE6: number;

  /** Current lifecycle status */
  status: PositionStatus;

  /** Certificate mint protecting this position (null if unprotected) */
  protectedBy: string | null;

  /** PDA bump seed */
  bump: number;
}

// ---------------------------------------------------------------------------
// Certificate state — the corridor hedge certificate
// ---------------------------------------------------------------------------

export enum CertificateStatus {
  /** Certificate created but not yet active */
  Created = 0,
  /** Active: protection in force */
  Active = 1,
  /** Settled: payout computed and disbursed */
  Settled = 2,
  /** Expired: tenor elapsed with no payout (price >= entry) */
  Expired = 3,
}

export interface CertificateState {
  /** Position mint this certificate protects */
  positionMint: string;

  /** Buyer (LP) wallet */
  buyer: string;

  /** Pool this certificate draws from */
  pool: string;

  /** Template ID used for this certificate */
  templateId: number;

  /** SOL/USDC entry price at purchase (micro-USD) */
  entryPriceE6: number;

  /**
   * Lower barrier price (micro-USD).
   * Equals the lower bound of the LP's CL range: S_0 * (1 - widthBps / BPS).
   * The corridor payoff is capped at the loss evaluated at this barrier.
   */
  lowerBarrierE6: number;

  /** Position notional value at entry (micro-USDC) */
  notionalUsdc: number;

  /**
   * Natural cap: maximum payout = V(S_0) - V(B).
   * This is the full IL within the concentrated liquidity range.
   */
  capUsdc: number;

  /** Total premium paid by LP (micro-USDC) */
  premiumUsdc: number;

  /** Protocol fee deducted from premium (micro-USDC) */
  protocolFeeUsdc: number;

  /** Fee-split rate y frozen at purchase time */
  feeSplitRate: number;

  /** Expected weekly fees E[F] used in premium computation (micro-USDC) */
  expectedWeeklyFeesUsdc: number;

  /** Unix timestamp of certificate purchase */
  purchaseTs: number;

  /** Unix timestamp of certificate expiry (purchaseTs + tenorSeconds) */
  expiryTs: number;

  /** Current lifecycle status */
  state: CertificateStatus;

  /** Settlement price (filled at settlement, micro-USD) */
  settlementPriceE6?: number;

  /** Payout to LP (filled at settlement, micro-USDC) */
  payoutUsdc?: number;

  /** Fee income transferred to RT pool (filled at settlement, micro-USDC) */
  rtFeeIncomeUsdc?: number;

  /** PDA bump seed */
  bump: number;
}

// ---------------------------------------------------------------------------
// Regime snapshot — volatility and market regime parameters
// ---------------------------------------------------------------------------

export interface RegimeSnapshot {
  /** Pool this snapshot belongs to */
  pool: string;

  /** 30-day annualized realized volatility (PPM) */
  sigmaPpm: number;

  /** 7-day annualized realized volatility (PPM) */
  sigma7dPpm: number;

  /** Stress flag: true during elevated-risk regimes */
  stressFlag: boolean;

  /** Daily carry cost in basis points */
  carryBpsPerDay: number;

  /**
   * Calibrated severity for the heuristic fair-value proxy (PPM).
   * Adjusted so that the heuristic approximates the GH quadrature FV.
   */
  severityPpm: number;

  /** Implied-to-realized volatility ratio (e.g. 1.08) */
  ivRvRatio: number;

  /** Resolved effective markup: max(markupFloor, ivRvRatio) */
  effectiveMarkup: number;

  /** Unix timestamp of last update */
  updatedAt: number;

  /** PDA bump seed */
  bump: number;
}

// ---------------------------------------------------------------------------
// Template configuration — product parameters
// ---------------------------------------------------------------------------

export interface TemplateConfig {
  /** Unique template identifier */
  templateId: number;

  /**
   * Position width in BPS (e.g. 1000 = +/-10%).
   * The barrier is derived from this: B = S_0 * (1 - widthBps / BPS).
   */
  widthBps: number;

  /** Certificate tenor in seconds (e.g. 604800 = 7 days) */
  tenorSeconds: number;

  /** Heuristic fair-value ceiling (micro-USDC) — safety bound */
  premiumCeilingUsdc: number;

  /** Expected daily LP fee rate for this width (BPS, e.g. 45 = 0.45%) */
  expectedDailyFeeBps: number;
}

// ---------------------------------------------------------------------------
// Quote result — returned by the pricing engine
// ---------------------------------------------------------------------------

export interface QuoteResult {
  /** Final premium charged to LP (micro-USDC) */
  premiumUsdc: number;

  /** Fair value of the corridor payoff (micro-USDC) */
  fairValueUsdc: number;

  /** Effective volatility markup applied */
  effectiveMarkup: number;

  /** Fee discount: y * E[F] (micro-USDC) */
  feeDiscountUsdc: number;

  /** Natural cap: V(S_0) - V(B) (micro-USDC) */
  capUsdc: number;

  /** Barrier price = lower bound of CL range (micro-USD) */
  barrierE6: number;

  /** Entry price used for the quote (micro-USD) */
  entryPriceE6: number;
}
