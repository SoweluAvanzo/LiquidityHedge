/**
 * Liquidity Hedge Protocol v2 — Off-chain Emulator
 *
 * This module exports all protocol types, constants, configuration, and
 * operations for the v2 off-chain emulator.
 *
 * v2 key changes from v1:
 * - Two-part premium: P_total = alpha * FairValue * vol_indicator + beta * fees_accrued
 * - Dynamic severity: severityPpm moved from TemplateConfig to RegimeSnapshot
 * - Markup reduced to 1.10x (from 1.20x)
 * - Only +/-5% and +/-10% widths (+/-15% dropped)
 *
 * Usage:
 *   import {
 *     initPool, depositUsdc, withdrawUsdc,
 *     registerLockedPosition, releasePosition,
 *     buyCertificate, settleCertificate,
 *     updateRegime, computeQuote, computeTwoPartQuote,
 *   } from './protocol-src';
 */

// ─── Types ───────────────────────────────────────────────────────────

export type {
  PremiumMode,
  TwoPartPremiumConfig,
  PoolState,
  PositionState,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
  QuoteBreakdown,
  TwoPartQuoteResult,
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
  RtPositionStatus,
  PPM,
  BPS,
  PPM_BI,
  BPS_BI,
  PYTH_MAX_STALENESS_S,
  ENTRY_PRICE_TOLERANCE_PPM,
  PYTH_MAX_CONFIDENCE_PPM,
  REGIME_MAX_AGE_S,
  DEFAULT_MARKUP,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_ALPHA,
} from "./types";

// ─── Configuration ───────────────────────────────────────────────────

export {
  OPTIMIZED_TEMPLATES,
  OPTIMIZED_POOL,
  DEFAULT_REGIME_SEVERITY,
  TEMPLATE_LABELS,
  EXPECTED_DAILY_FEE_RATES,
  DEFAULT_BARRIER_PCT,
  barrierPctForWidth,
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
  computeTwoPartQuote,
  computeVolIndicator,
  resolveEffectiveMarkup,
  calibrateSeverity,
  heuristicPremiumUsdc,
  integerSqrt,
} from "./operations/pricing";

// ─── Regime Operations ───────────────────────────────────────────────

export {
  updateRegime,
  calibrateSeverityForPool,
  calibrateSeverityForWidth,
  computeIvRvFromDualSource,
  isRegimeFresh,
  regimeVolIndicator,
  describeRegime,
} from "./operations/regime";

export type { RegimeStore } from "./operations/regime";
