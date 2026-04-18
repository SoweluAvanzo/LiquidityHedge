/**
 * Shared types for the Liquidity Hedge Protocol v2.
 *
 * These types mirror the on-chain Rust state definitions in
 * programs/lh-core/src/state.rs. Both the off-chain emulator
 * and the on-chain adapter use these same types, ensuring 1:1
 * correspondence and enabling seamless swapping.
 *
 * v2 changes:
 * - severityPpm moved from TemplateConfig to RegimeSnapshot (dynamic calibration)
 * - Two-part premium model: P_total = alpha * FairValue(sigma) * vol_indicator + beta * fees_accrued
 * - Markup reduced from 1.20x to 1.10x
 * - Only +/-5% and +/-10% widths (dropped +/-15%)
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

export const RtPositionStatus = {
  ACTIVE: 1,
  EXITED_EARLY: 2,
  EXITED_AT_EXPIRY: 3,
  REPLACED: 4,
} as const;

// ─── Protocol Constants (from constants.rs) ──────────────────────────

export const PPM = 1_000_000;       // parts per million
export const BPS = 10_000;          // basis points
export const PYTH_MAX_STALENESS_S = 30;
export const ENTRY_PRICE_TOLERANCE_PPM = 50_000; // 5%
export const PYTH_MAX_CONFIDENCE_PPM = 50_000;   // 5%
export const REGIME_MAX_AGE_S = 900;             // 15 minutes

// ─── v2 Constants ────────────────────────────────────────────────────

/** Default markup factor for heuristic premium over fair value (reduced from 1.20 in v1). */
export const DEFAULT_MARKUP = 1.10;

/** Default alpha (upfront weight) in the two-part premium split. */
export const DEFAULT_ALPHA = 0.40;

/** Minimum markup floor: effective markup = max(floor, IV/RV ratio). */
export const DEFAULT_MARKUP_FLOOR = 1.05;

// ─── BigInt Constants for on-chain integer arithmetic ────────────────

export const PPM_BI = BigInt(PPM);   // 1_000_000n
export const BPS_BI = BigInt(BPS);   // 10_000n

// ─── Premium Mode ────────────────────────────────────────────────────

/**
 * Premium payment mode.
 * - 'fixed': entire premium paid upfront at certificate purchase (v1 behavior)
 * - 'two-part': premium split into alpha * heuristic (upfront) + beta * fees (at settlement)
 */
export type PremiumMode = 'fixed' | 'two-part';

/**
 * Configuration for the two-part premium model.
 *
 * P_total = alpha * HeuristicPremium * vol_indicator  +  beta * fees_accrued
 *
 * Where:
 * - alpha: fraction of the heuristic premium paid upfront (e.g. 0.40)
 * - markup: target ratio of total premium to fair value (e.g. 1.10)
 * - beta = (markup - alpha) * heuristicPremium / expectedWeeklyFees
 * - vol_indicator: sigma_7d / sigma_30d, clipped to [0.5, 2.0]
 */
export interface TwoPartPremiumConfig {
  alpha: number;
  markup: number;
  premiumMode: PremiumMode;
}

// ─── State Types (mirror state.rs) ───────────────────────────────────

export interface PoolState {
  admin: string;               // base58 pubkey
  usdcMint: string;
  usdcVault: string;           // vault ATA address
  reservesUsdc: number;        // micro-USDC (u64)
  activeCapUsdc: number;
  totalShares: number;
  uMaxBps: number;
  /** v2: premium payment mode ('fixed' = v1, 'two-part' = v2 default) */
  premiumMode: PremiumMode;
  /** v2: alpha parameter for two-part premium (fraction, e.g. 0.40) */
  twoPartAlpha: number;
  // Protocol fee configuration
  protocolFeeBps?: number;        // default 150 = 1.5% of premium to treasury
  treasuryPubkey?: string;        // treasury wallet address (optional)
  protocolFeesCollected?: number;  // cumulative micro-USDC protocol fees
  /** Minimum markup floor for IV/RV-adaptive pricing (default: DEFAULT_MARKUP_FLOOR) */
  markupFloor?: number;
}

export interface PositionState {
  owner: string;
  whirlpool: string;
  positionMint: string;
  lowerTick: number;
  upperTick: number;
  p0PriceE6: number;
  oracleP0E6: number;
  depositedA: number;          // lamports
  depositedB: number;          // micro-USDC
  liquidity: string;           // bigint as string for JSON serialization
  protectedBy: string | null;  // positionMint of cert, or null
  status: number;              // PositionStatus
}

export interface CertificateState {
  owner: string;
  positionMint: string;        // identifies both position and certificate
  pool: string;
  templateId: number;
  premiumUsdc: number;         // total premium (upfront + deferred)
  capUsdc: number;
  lowerBarrierE6: number;
  notionalUsdc: number;
  expiryTs: number;            // unix seconds
  state: number;               // CertStatus
  nftMint: string;
  // v2: two-part premium fields
  premiumUpfrontUsdc: number;
  premiumDeferredUsdc: number;
  betaFraction: number;        // beta coefficient for fee-based settlement portion
  feesAccruedUsdc: number;     // actual LP fees accrued during tenor (set at settlement)
  settlementPremiumUsdc: number; // beta * feesAccruedUsdc (computed at settlement)
}

/**
 * Regime snapshot capturing current market conditions.
 *
 * v2: severityPpm is now per-regime (dynamic), not per-template (static).
 * This allows the protocol to auto-calibrate severity based on realized
 * volatility, ensuring the heuristic premium tracks fair value under
 * changing market conditions.
 */
export interface RegimeSnapshot {
  sigmaPpm: number;            // annualized 7-day sigma (e.g. 650_000 = 65%)
  sigmaMaPpm: number;          // 30-day moving average sigma
  stressFlag: boolean;
  carryBpsPerDay: number;
  updatedTs: number;           // unix seconds
  signer: string;
  /** v2: dynamic severity, auto-calibrated so heuristic ~ markup * fair value */
  severityPpm: number;
  /** IV/RV ratio from option market (implied vol / realized vol) */
  ivRvRatio?: number;
  /** Markup floor in PPM (configurable per-pool) */
  markupFloorPpm?: number;
  /** Effective markup = max(floor, ivRvRatio). Falls back to DEFAULT_MARKUP if unset. */
  effectiveMarkup?: number;
}

/**
 * Template configuration for a hedge product.
 *
 * v2: severityPpm has been REMOVED from templates — it is now in RegimeSnapshot.
 * Templates define only the structural product parameters.
 */
export interface TemplateConfig {
  templateId: number;
  tenorSeconds: number;
  widthBps: number;
  premiumFloorUsdc: number;
  premiumCeilingUsdc: number;
  active: boolean;
}

// ─── Quote Breakdown ─────────────────────────────────────────────────

/**
 * Breakdown of a premium quote.
 *
 * v2: includes two-part premium components (upfront, deferred, beta).
 */
export interface QuoteBreakdown {
  premiumUsdc: number;         // total heuristic premium (fixed-mode)
  capUsdc: number;
  expectedPayoutUsdc: number;
  capitalChargeUsdc: number;
  adverseSelectionUsdc: number;
  replicationCostUsdc: number;
  // v2: two-part premium fields
  premiumUpfrontUsdc: number;  // alpha * heuristicPremium * volIndicator
  premiumDeferredUsdc: number; // estimated deferred = (markup - alpha) * heuristicPremium
  betaFraction: number;        // beta = deferredEstimate / expectedWeeklyFees
}

/**
 * Result of the two-part quote computation.
 */
export interface TwoPartQuoteResult {
  /** USDC to pay upfront: alpha * heuristicPremium * volIndicator */
  upfrontUsdc: number;
  /** beta coefficient: deferred per unit of fee accrued */
  betaFraction: number;
  /** Estimated total if expected fees materialize: upfront + beta * expectedFees */
  estimatedTotalUsdc: number;
  /** The underlying heuristic premium (before alpha/beta split) */
  heuristicPremiumUsdc: number;
  /** Vol indicator used: sigma7d / sigma30d clipped to [0.5, 2.0] */
  volIndicator: number;
}

// ─── Operation Parameter Types ───────────────────────────────────────

export interface RegisterPositionParams {
  positionMint: string;        // base58 pubkey
  whirlpool: string;
  p0PriceE6: number;
  depositedA: number;
  depositedB: number;
  lowerTick: number;
  upperTick: number;
}

export interface TemplateParams {
  templateId: number;
  tenorSeconds: number;
  widthBps: number;
  premiumFloorUsdc: number;
  premiumCeilingUsdc: number;
}

export interface RegimeParams {
  sigmaPpm: number;
  sigmaMaPpm: number;
  stressFlag: boolean;
  carryBpsPerDay: number;
  /** Optional IV/RV ratio from option market data */
  ivRvRatio?: number;
}

export interface BuyCertParams {
  positionMint: string;        // base58 pubkey
  templateId: number;
  capUsdc: number;
  lowerBarrierE6: number;
  notionalUsdc: number;
  /** Expected weekly LP fees in micro-USDC (required for two-part mode) */
  expectedWeeklyFeesUsdc?: number;
}

// ─── Operation Result Types ──────────────────────────────────────────

export interface BuyCertResult {
  premiumUsdc: number;
  capUsdc: number;
  expiryTs: number;
  premiumUpfrontUsdc: number;
  premiumDeferredUsdc: number;
  betaFraction: number;
}

export interface SettleResult {
  payout: number;
  state: number;               // CertStatus.SETTLED or CertStatus.EXPIRED
  settlementPriceE6: number;
  conservativePriceE6: number;
  feesAccruedUsdc: number;
  settlementPremiumUsdc: number; // beta * feesAccrued (two-part deferred)
  totalPremiumUsdc: number;      // upfront + settlement
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
  premiumMode: PremiumMode;
  twoPartAlpha: number;
  protocolFeeBps?: number;
  treasuryPubkey?: string;
  /** Minimum markup floor for IV/RV-adaptive pricing (default: DEFAULT_MARKUP_FLOOR) */
  markupFloor?: number;
}
