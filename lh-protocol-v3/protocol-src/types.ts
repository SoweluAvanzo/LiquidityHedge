/**
 * Shared types for the Liquidity Hedge Protocol v3.
 *
 * These types mirror the on-chain Rust state definitions in
 * programs/lh-core/src/state.rs. Both the off-chain emulator
 * and the on-chain adapter use these same types.
 *
 * v3 changes from v2:
 * - Removed two-part premium types (PremiumMode, TwoPartPremiumConfig, alpha/beta)
 * - Added coverRatio to CertificateState (LP chooses 0.25 to 1.00)
 * - Added feeSplitRate to PoolState (fraction of LP fees flowing to RT at settlement)
 * - Added expectedDailyFee to PoolState (expected daily fee rate for discount calc)
 * - Added barrierDepthBps to TemplateConfig (replaces fixed width-based barrier)
 * - Premium = FV * max(floor, IV/RV) * coverRatio - feeSplitRate * E[weeklyFees]
 * - Fee split: RT receives feeSplitRate% of actual LP fees at settlement
 */

// ─── Status Constants (from state.rs) ────────────────────────────────

export const PositionStatus = {
  LOCKED: 1,
  RELEASED: 2,
  CLOSED: 3,
} as const;

export const CertStatus = {
  CREATED: 0,
  ACTIVE: 1,
  SETTLED: 2,
  EXPIRED: 3,
} as const;

// ─── Protocol Constants (from constants.rs) ──────────────────────────

export const PPM = 1_000_000;       // parts per million
export const BPS = 10_000;          // basis points
export const PPM_BI = BigInt(PPM);  // 1_000_000n
export const BPS_BI = BigInt(BPS);  // 10_000n
export const PYTH_MAX_STALENESS_S = 30;
export const ENTRY_PRICE_TOLERANCE_PPM = 50_000; // 5%
export const PYTH_MAX_CONFIDENCE_PPM = 50_000;   // 5%
export const REGIME_MAX_AGE_S = 900;             // 15 minutes

// ─── v3 Constants ────────────────────────────────────────────────────

/** Minimum markup floor: effective markup = max(floor, IV/RV ratio). */
export const DEFAULT_MARKUP_FLOOR = 1.05;

/** Default cover ratio: LP hedges 50% of natural cap. */
export const DEFAULT_COVER_RATIO = 0.50;

/** Default barrier depth: 7.5% below entry (barrier = S0 * 0.925 = lower tick). */
export const DEFAULT_BARRIER_DEPTH_BPS = 750;

/** Default fee split rate: 10% of LP's trading fees flow to RT at settlement. */
export const DEFAULT_FEE_SPLIT_RATE = 0.10;

/** Default expected daily fee rate: 0.5%/day (calibratable from on-chain data). */
export const DEFAULT_EXPECTED_DAILY_FEE = 0.005;

// ─── State Types (mirror state.rs) ───────────────────────────────────

export interface PoolState {
  admin: string;               // base58 pubkey
  usdcMint: string;
  usdcVault: string;           // vault ATA address
  reservesUsdc: number;        // micro-USDC (u64)
  activeCapUsdc: number;
  totalShares: number;
  uMaxBps: number;
  /** Fraction of LP's trading fees flowing to RT at settlement (0.10 = 10%). */
  feeSplitRate: number;
  /** Expected daily fee rate for premium discount calculation (0.005 = 0.5%/day). */
  expectedDailyFee: number;
  /** Minimum markup floor for IV/RV-adaptive pricing (1.05 = 5% above fair value). */
  markupFloor: number;
  /** Optional cap on effective markup (e.g. 1.80 = max 80% loading). */
  maxMarkup?: number;
  /** Utilization surcharge weight in PPM applied to markup (default 0). */
  utilizationRiskWeightPpm?: number;
  /** Stress add-on in PPM applied to markup when stressFlag=true (default 0). */
  stressMarkupAddOnPpm?: number;
  /** Protocol fee in BPS (150 = 1.5% of premium to treasury). */
  protocolFeeBps: number;
  /** Treasury wallet address (optional). */
  treasuryPubkey?: string;
  /** Cumulative micro-USDC protocol fees collected. */
  protocolFeesCollected?: number;
}

export interface PositionState {
  owner: string;
  whirlpool: string;
  positionMint: string;
  lowerTick: number;
  upperTick: number;
  p0PriceE6: number;
  liquidity: string;           // bigint as string for JSON serialization
  protectedBy: string | null;  // positionMint of cert, or null
  status: number;              // PositionStatus
}

export interface CertificateState {
  owner: string;
  positionMint: string;        // identifies both position and certificate
  pool: string;
  templateId: number;
  premiumUsdc: number;         // total premium paid upfront
  capUsdc: number;             // = natural_cap * cover_ratio
  /** LP's chosen cover ratio: fraction of natural cap hedged (0.25 to 1.00). */
  coverRatio: number;
  lowerBarrierE6: number;
  notionalUsdc: number;
  expiryTs: number;            // unix seconds
  state: number;               // CertStatus
  nftMint: string;
}

export interface RegimeSnapshot {
  sigmaPpm: number;            // annualized 7-day sigma (e.g. 650_000 = 65%)
  sigmaMaPpm: number;          // 30-day moving average sigma
  stressFlag: boolean;
  carryBpsPerDay: number;
  updatedTs: number;           // unix seconds
  signer: string;
  /** Dynamic severity, auto-calibrated so heuristic tracks markup * fair value. */
  severityPpm: number;
  /** IV/RV ratio from option market (lower of Bybit and Binance). */
  ivRvRatio: number;
  /** Effective markup = max(floor, ivRvRatio). */
  effectiveMarkup: number;
}

/**
 * Template configuration for a hedge product.
 *
 * v3: barrierDepthBps replaces the fixed width-based barrier derivation.
 * The barrier is computed as: barrier = S0 * (1 - barrierDepthBps / BPS).
 */
export interface TemplateConfig {
  templateId: number;
  tenorSeconds: number;
  widthBps: number;            // 750 = +/-7.5%
  /** Barrier depth below entry in BPS. 750 = 7.5% below entry (barrier = S0 * 0.925 = lower tick). */
  barrierDepthBps: number;
  premiumFloorUsdc: number;
  premiumCeilingUsdc: number;
  active: boolean;
}

// ─── Quote Breakdown ─────────────────────────────────────────────────

/**
 * Breakdown of a v3 premium quote.
 *
 * The LP sees 3 transparent numbers plus a fee discount:
 *   1. fairValueUsdc (GH no-arbitrage value)
 *   2. effectiveMarkup (max(floor, IV/RV))
 *   3. coverRatio (LP's choice)
 *
 * Premium = fairValue * effectiveMarkup * coverRatio - feeSplitRate * E[weeklyFees]
 */
export interface QuoteBreakdown {
  /** No-arbitrage fair value from Gauss-Hermite quadrature (micro-USDC). */
  fairValueUsdc: number;
  /** Effective markup applied: max(markupFloor, ivRvRatio). */
  effectiveMarkup: number;
  /** LP's cover ratio choice. */
  coverRatio: number;
  /** Final premium: fairValue * effectiveMarkup * coverRatio (micro-USDC). */
  premiumUsdc: number;
  /** Scaled cap: natural_cap * coverRatio (micro-USDC). */
  capUsdc: number;
  /** Heuristic premium subcomponents (for diagnostics). */
  expectedPayoutUsdc: number;
  capitalChargeUsdc: number;
  adverseSelectionUsdc: number;
  replicationCostUsdc: number;
}

// ─── Operation Parameter Types ───────────────────────────────────────

export interface RegisterPositionParams {
  positionMint: string;        // base58 pubkey
  whirlpool: string;
  p0PriceE6: number;
  lowerTick: number;
  upperTick: number;
}

export interface TemplateParams {
  templateId: number;
  tenorSeconds: number;
  widthBps: number;
  barrierDepthBps: number;
  premiumFloorUsdc: number;
  premiumCeilingUsdc: number;
}

export interface RegimeParams {
  sigmaPpm: number;
  sigmaMaPpm: number;
  stressFlag: boolean;
  carryBpsPerDay: number;
  /** IV/RV ratio from option market data (lower of Bybit and Binance). */
  ivRvRatio?: number;
  /** Optional realized payout ratio in PPM for feedback correction. */
  realizedLossPpm?: number;
  /** Optional expected payout ratio in PPM for feedback correction. */
  expectedLossPpm?: number;
  /** Optional feedback aggressiveness in PPM (default 200_000 = 20%). */
  feedbackGainPpm?: number;
  /** Optional max per-update severity change in PPM (default 25_000). */
  maxSeverityStepPpm?: number;
}

export interface BuyCertParams {
  positionMint: string;        // base58 pubkey
  templateId: number;
  /** Natural cap before cover ratio scaling (micro-USDC). */
  naturalCapUsdc: number;
  /** LP's chosen cover ratio (0.25 to 1.00). Defaults to DEFAULT_COVER_RATIO. */
  coverRatio?: number;
  notionalUsdc: number;
  /** Optional explicit barrier. If omitted, derived from template.barrierDepthBps. */
  lowerBarrierE6?: number;
}

// ─── Operation Result Types ──────────────────────────────────────────

export interface BuyCertResult {
  premiumUsdc: number;
  capUsdc: number;
  coverRatio: number;
  effectiveMarkup: number;
  expiryTs: number;
}

export interface SettleResult {
  /** Payout to LP (scaled by coverRatio). */
  payout: number;
  /** Full payout before cover-ratio scaling (diagnostic). */
  fullPayout: number;
  /** RT fee income: feeSplitRate * actual LP fees (flows to RT pool). */
  rtFeeIncome: number;
  /** Net LP receives: payout (fee split already excluded from pool). */
  netLpPayout: number;
  state: number;               // CertStatus.SETTLED or CertStatus.EXPIRED
  settlementPriceE6: number;
  conservativePriceE6: number;
  feesAccruedUsdc: number;
}

export interface DepositResult {
  shares: number;
}

export interface WithdrawResult {
  usdcReturned: number;
}

// ─── Pool Init Config ────────────────────────────────────────────────

export interface PoolInitConfig {
  admin: string;
  usdcMint: string;
  usdcVault: string;
  uMaxBps: number;
  feeSplitRate: number;
  expectedDailyFee: number;
  markupFloor: number;
  protocolFeeBps?: number;
  treasuryPubkey?: string;
}
