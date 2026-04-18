/**
 * Liquidity Hedge Protocol v3 -- Off-chain Emulator
 *
 * This module exports all protocol types, constants, configuration, and
 * operations for the v3 off-chain emulator.
 *
 * v3 key changes from v2:
 * - Simplified pricing: Premium = FV * max(floor, IV/RV) * coverRatio - feeDiscount
 * - Removed two-part premium (alpha/beta split, vol indicator)
 * - Added coverRatio: LP chooses how much of natural cap to hedge (0.25-1.00)
 * - Fee split: RT receives feeSplitRate% of LP fees at settlement
 * - Fee discount: feeSplitRate * E[weeklyFees] subtracted from upfront premium
 * - Configurable barrier depth via barrierDepthBps in TemplateConfig
 * - Single template: +/-10% width (dropped +/-5% based on simulation)
 *
 * Usage:
 *   import {
 *     initPool, depositUsdc, withdrawUsdc,
 *     registerLockedPosition, releasePosition,
 *     buyCertificate, settleCertificate,
 *     updateRegime, computeQuote,
 *   } from './protocol-src';
 */

// ─── Types ───────────────────────────────────────────────────────────

export type {
  PoolState,
  PositionState,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
  QuoteBreakdown,
  RegisterPositionParams,
  TemplateParams,
  RegimeParams,
  BuyCertParams,
  BuyCertResult,
  SettleResult,
  DepositResult,
  WithdrawResult,
  PoolInitConfig,
} from "./types";

export {
  PositionStatus,
  CertStatus,
  PPM,
  BPS,
  PPM_BI,
  BPS_BI,
  PYTH_MAX_STALENESS_S,
  ENTRY_PRICE_TOLERANCE_PPM,
  PYTH_MAX_CONFIDENCE_PPM,
  REGIME_MAX_AGE_S,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_COVER_RATIO,
  DEFAULT_BARRIER_DEPTH_BPS,
  DEFAULT_FEE_SPLIT_RATE,
  DEFAULT_EXPECTED_DAILY_FEE,
} from "./types";

// ─── Configuration ───────────────────────────────────────────────────

export {
  V3_TEMPLATES,
  V3_POOL_DEFAULTS,
  DEFAULT_SEVERITY_PPM,
  TEMPLATE_LABELS,
  EXPECTED_DAILY_FEE_RATES,
  DEFAULT_BARRIER_PCT,
  computeBarrierPrice,
  buildPoolInitConfig,
} from "./config/templates";

// ─── Pool Operations ─────────────────────────────────────────────────

export {
  initPool,
  depositUsdc,
  withdrawUsdc,
  sharePrice,
  utilization,
  availableHeadroom,
} from "./operations/pool";

export type { PoolStore } from "./operations/pool";

// ─── Position Operations ─────────────────────────────────────────────

export {
  registerLockedPosition,
  releasePosition,
  closePosition,
  isPositionHedgeable,
  isPositionReleasable,
} from "./operations/vault-positions";

export type { PositionStore } from "./operations/vault-positions";

// ─── Certificate Operations ─────────────────────────────────────────

export {
  buyCertificate,
  settleCertificate,
} from "./operations/certificates";

export type { CertStore } from "./operations/certificates";

// ─── Pricing Operations ─────────────────────────────────────────────

export {
  computeQuote,
  computeV3Premium,
  computeV3Payout,
  computeRtFeeIncome,
  computeHeuristicPremium,
  resolveEffectiveMarkup,
  calibrateSeverity,
  integerSqrt,
} from "./operations/pricing";

// ─── Regime Operations ───────────────────────────────────────────────

export {
  updateRegime,
  calibrateSeverityForPool,
  calibrateSeverityForWidth,
  computeIvRvFromDualSource,
  isRegimeFresh,
  describeRegime,
} from "./operations/regime";

export type { RegimeStore } from "./operations/regime";
