/**
 * Pricing operations: quote computation, two-part premium, severity calibration.
 *
 * v2 changes:
 * - severityPpm now read from RegimeSnapshot (dynamic) instead of TemplateConfig (static)
 * - computeQuote returns extended QuoteBreakdown with upfront/deferred/beta fields
 * - New: computeTwoPartQuote() for the two-part premium model
 * - New: calibrateSeverity() solver for auto-tuning severity
 * - New: computeVolIndicator() for sigma_7d / sigma_30d ratio
 * - Markup reduced from 1.20x to 1.10x
 *
 * The heuristic premium formula is identical to v1:
 *   Premium = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling)
 * but severity is sourced from a different location (regime, not template).
 *
 * The two-part premium model splits the total into:
 *   P_upfront  = alpha * HeuristicPremium * vol_indicator
 *   P_deferred = beta * fees_accrued_during_tenor
 * where beta is calibrated so that:
 *   alpha * H + beta * E[fees] ~ markup * FairValue
 */

import {
  PoolState,
  RegimeSnapshot,
  TemplateConfig,
  QuoteBreakdown,
  TwoPartQuoteResult,
  PPM,
  BPS,
  PPM_BI,
  BPS_BI,
  DEFAULT_MARKUP,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_ALPHA,
} from "../types";

// ─── Integer Square Root (from math.rs) ──────────────────────────────

/** Newton's method integer sqrt — identical to programs/lh-core/src/math.rs */
export function integerSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ─── Vol Indicator ───────────────────────────────────────────────────

/**
 * Compute the volatility indicator: sigma_7d / sigma_30d, clipped to [0.5, 2.0].
 *
 * This ratio captures whether short-term vol is elevated (>1) or subdued (<1)
 * relative to the longer-term moving average. It scales the upfront premium
 * component in the two-part model so that LPs pay more when vol is spiking
 * and less during calm periods.
 *
 * @param sigma7dPpm  7-day annualized sigma in PPM (e.g. 650_000 = 65%)
 * @param sigma30dPpm 30-day moving-average sigma in PPM
 * @returns clipped ratio in [0.5, 2.0]
 */
export function computeVolIndicator(sigma7dPpm: number, sigma30dPpm: number): number {
  if (sigma30dPpm <= 0) return 1.0; // fallback: neutral
  const ratio = sigma7dPpm / sigma30dPpm;
  return Math.max(0.5, Math.min(2.0, ratio));
}

// ─── Effective Markup (IV/RV-adaptive) ──────────────────────────────

/**
 * Resolve the effective markup for premium pricing.
 *
 * Priority:
 * 1. If regime.effectiveMarkup is already set, use it directly.
 * 2. Otherwise, compute max(floor, ivRvRatio) where:
 *    - floor comes from pool.markupFloor (default: DEFAULT_MARKUP_FLOOR = 1.05)
 *    - ivRvRatio comes from regime.ivRvRatio (default: DEFAULT_MARKUP = 1.10)
 *
 * This allows the protocol to adapt markup dynamically based on the ratio
 * of implied volatility to realized volatility from option markets.
 */
export function resolveEffectiveMarkup(
  regime: RegimeSnapshot,
  pool?: PoolState,
): number {
  if (regime.effectiveMarkup != null) return regime.effectiveMarkup;
  const floor = pool?.markupFloor ?? DEFAULT_MARKUP_FLOOR;
  const ivRv = regime.ivRvRatio ?? DEFAULT_MARKUP;
  return Math.max(floor, ivRv);
}

// ─── Heuristic Premium (core formula) ────────────────────────────────

/**
 * Compute the raw heuristic premium — the same on-chain formula from v1
 * but reading severityPpm from the regime snapshot.
 *
 * This is the UNCLAMPED premium before floor/ceiling bounds. It is used
 * internally by both computeQuote (clamped) and calibrateSeverity (unclamped).
 *
 * Formula:
 *   E[Payout] = Cap * p_hit(sigma, T, width) * severity / PPM^2
 *   C_cap     = Cap * (U_after / PPM)^2 / 5
 *   C_adv     = Cap / 10 if stress, else 0
 *   C_rep     = Cap * carry_bps * tenor_seconds / BPS / (100 * 86400)
 *
 * @returns Object with individual components and unclamped total (all as bigint).
 */
function computeHeuristicComponents(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
): {
  expectedPayout: bigint;
  capitalCharge: bigint;
  adverse: bigint;
  replication: bigint;
  unclamped: bigint;
  uAfterPpm: bigint;
} {
  const reserves = BigInt(Math.max(pool.reservesUsdc, 1));
  const active = BigInt(pool.activeCapUsdc);
  const cap = BigInt(capUsdc);

  // Utilization after this certificate
  const uAfterPpm = ((active + cap) * PPM_BI) / reserves;
  const uMaxPpm = BigInt(pool.uMaxBps) * 100n;

  if (uAfterPpm > uMaxPpm) {
    throw new Error(
      `InsufficientHeadroom: utilization ${uAfterPpm} > max ${uMaxPpm}`
    );
  }

  // p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
  const sigmaPpm = BigInt(regime.sigmaPpm);
  const secondsPerYear = 365n * 86_400n;
  const tenorPpm = (BigInt(template.tenorSeconds) * PPM_BI) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * PPM_BI);
  const widthPpm = BigInt(template.widthBps) * 100n;

  let pHitPpm =
    (900_000n * sigmaPpm * sqrtTPpm) /
    PPM_BI /
    (widthPpm > 0n ? widthPpm : 1n);
  if (pHitPpm > PPM_BI) pHitPpm = PPM_BI;

  const severityPpm = BigInt(regime.severityPpm);

  // E[Payout]
  const expectedPayout = (cap * pHitPpm * severityPpm) / PPM_BI / PPM_BI;

  // C_cap (quadratic utilization charge)
  const capitalCharge = (cap * uAfterPpm * uAfterPpm) / PPM_BI / PPM_BI / 5n;

  // C_adv (adverse selection)
  const adverse = regime.stressFlag ? cap / 10n : 0n;

  // C_rep (replication cost) — prorated to seconds
  const replication =
    (cap * BigInt(regime.carryBpsPerDay) * BigInt(template.tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);

  const unclamped = expectedPayout + capitalCharge + adverse + replication;

  return { expectedPayout, capitalCharge, adverse, replication, unclamped, uAfterPpm };
}

// ─── Quote Computation ───────────────────────────────────────────────

/**
 * Compute premium quote — exact port of pricing/instructions.rs:compute_quote,
 * adapted for v2 (severity from regime, extended breakdown).
 *
 * In fixed mode, premiumUpfrontUsdc = premiumUsdc and premiumDeferredUsdc = 0.
 * In two-part mode, the caller should use computeTwoPartQuote() for the split,
 * but this function still provides the raw heuristic for reference.
 *
 * @param capUsdc   Maximum payout in micro-USDC
 * @param template  Template configuration (without severity)
 * @param pool      Current pool state
 * @param regime    Current regime snapshot (WITH severity)
 * @returns Full quote breakdown
 */
export function computeQuote(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
): QuoteBreakdown {
  const {
    expectedPayout,
    capitalCharge,
    adverse,
    replication,
    unclamped,
  } = computeHeuristicComponents(capUsdc, template, pool, regime);

  // Clamp to [floor, ceiling]
  const floor = BigInt(template.premiumFloorUsdc);
  const ceiling = BigInt(template.premiumCeilingUsdc);
  let premium = unclamped;
  if (premium < floor) premium = floor;
  if (premium > ceiling) premium = ceiling;

  const premiumUsdc = Number(premium);

  return {
    premiumUsdc,
    capUsdc,
    expectedPayoutUsdc: Number(expectedPayout),
    capitalChargeUsdc: Number(capitalCharge),
    adverseSelectionUsdc: Number(adverse),
    replicationCostUsdc: Number(replication),
    // In fixed mode, full premium is upfront
    premiumUpfrontUsdc: premiumUsdc,
    premiumDeferredUsdc: 0,
    betaFraction: 0,
  };
}

// ─── Two-Part Quote ──────────────────────────────────────────────────

/**
 * Compute the two-part premium split.
 *
 * The model decomposes the heuristic premium H into:
 *   P_upfront  = alpha * H * vol_indicator
 *   P_deferred ~ beta * fees_accrued
 *
 * Where beta is calibrated so the expected total equals markup * fair_value:
 *   alpha * H * vol_indicator + beta * E[fees] = markup_target * H
 *
 * Solving for beta:
 *   beta = (markup_target * H - alpha * H * vol_indicator) / E[fees]
 *        = H * (markup_target - alpha * vol_indicator) / E[fees]
 *
 * If expectedWeeklyFees is zero or negative, beta is set to 0 and the
 * full premium falls back to upfront-only.
 *
 * @param capUsdc              Maximum payout in micro-USDC
 * @param template             Template configuration
 * @param pool                 Current pool state
 * @param regime               Current regime snapshot
 * @param expectedWeeklyFeesUsdc  Expected LP fee income over the tenor (micro-USDC)
 * @returns Two-part quote with upfront, beta, and estimated total
 */
export function computeTwoPartQuote(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
  expectedWeeklyFeesUsdc: number,
): TwoPartQuoteResult {
  const quote = computeQuote(capUsdc, template, pool, regime);
  const heuristicPremium = quote.premiumUsdc;

  const alpha = pool.twoPartAlpha > 0 ? pool.twoPartAlpha : DEFAULT_ALPHA;
  const volIndicator = computeVolIndicator(regime.sigmaPpm, regime.sigmaMaPpm);

  // Upfront component: alpha * H * vol_indicator
  const upfrontUsdc = Math.floor(alpha * heuristicPremium * volIndicator);

  // Beta: deferred per unit of fee
  // Target total = markup * H (using DEFAULT_MARKUP as the target ratio)
  // deferred_target = markup * H - upfront
  // beta = deferred_target / E[fees]
  let betaFraction = 0;
  let estimatedTotalUsdc = upfrontUsdc;

  if (expectedWeeklyFeesUsdc > 0) {
    const markupTarget = (regime.effectiveMarkup ?? DEFAULT_MARKUP) * heuristicPremium;
    const deferredTarget = Math.max(0, markupTarget - upfrontUsdc);
    betaFraction = deferredTarget / expectedWeeklyFeesUsdc;

    // Estimate total if expected fees materialize
    estimatedTotalUsdc = upfrontUsdc + Math.floor(betaFraction * expectedWeeklyFeesUsdc);
  }

  return {
    upfrontUsdc,
    betaFraction,
    estimatedTotalUsdc,
    heuristicPremiumUsdc: heuristicPremium,
    volIndicator,
  };
}

// ─── Severity Calibration ────────────────────────────────────────────

/**
 * Calibrate severityPpm so that the heuristic premium ~ markup * fairValue.
 *
 * Uses a simple bisection solver. The fair value proxy is estimated as:
 *   fairValue ~ Cap * p_hit * (width / 2) / PPM
 * which is the expected CL loss under a normal model. The heuristic must
 * then satisfy:
 *   heuristic(severity) ~ markup * fairValue
 *
 * Since the heuristic is linear in severity (via expectedPayout), we can
 * solve analytically for the severity that makes E[Payout] equal the
 * target minus the other cost components:
 *
 *   target = markup * fairValue
 *   E[Payout]_target = target - C_cap - C_adv - C_rep
 *   severity = E[Payout]_target * PPM^2 / (Cap * p_hit)
 *
 * If the target is less than the non-severity costs, severity is floored at 1.
 *
 * @param sigmaPpm       Current annualized sigma in PPM
 * @param widthBps       Position width in basis points
 * @param capUsdc        Reference cap for calibration (e.g. 100_000_000 = $100)
 * @param tenorSeconds   Certificate tenor in seconds
 * @param pool           Pool state (for utilization computation)
 * @param stressFlag     Whether stress conditions apply
 * @param carryBpsPerDay Carry cost rate
 * @param markup         Target markup ratio (default: DEFAULT_MARKUP = 1.10)
 * @returns Calibrated severityPpm
 */
export function calibrateSeverity(
  sigmaPpm: number,
  widthBps: number,
  capUsdc: number,
  tenorSeconds: number,
  pool: PoolState,
  stressFlag: boolean,
  carryBpsPerDay: number,
  markup: number = DEFAULT_MARKUP,
): number {
  const cap = BigInt(capUsdc);

  // Compute p_hit (same formula as in computeHeuristicComponents)
  const secondsPerYear = 365n * 86_400n;
  const tenorPpm = (BigInt(tenorSeconds) * PPM_BI) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * PPM_BI);
  const widthPpmBig = BigInt(widthBps) * 100n;

  let pHitPpm =
    (900_000n * BigInt(sigmaPpm) * sqrtTPpm) /
    PPM_BI /
    (widthPpmBig > 0n ? widthPpmBig : 1n);
  if (pHitPpm > PPM_BI) pHitPpm = PPM_BI;

  if (pHitPpm <= 0n) return 1; // degenerate: sigma or tenor is zero

  // Fair value proxy: Cap * p_hit * (width/2) / PPM
  // This approximates the expected CL loss under normal distribution.
  const halfWidthPpm = widthPpmBig / 2n;
  const fairValueBig = (cap * pHitPpm * halfWidthPpm) / PPM_BI / PPM_BI;
  const fairValue = Number(fairValueBig);

  if (fairValue <= 0) return 1;

  // Non-severity cost components
  const reserves = BigInt(Math.max(pool.reservesUsdc, 1));
  const active = BigInt(pool.activeCapUsdc);
  const uAfterPpm = ((active + cap) * PPM_BI) / reserves;

  const capitalCharge = (cap * uAfterPpm * uAfterPpm) / PPM_BI / PPM_BI / 5n;
  const adverse = stressFlag ? cap / 10n : 0n;
  const replication =
    (cap * BigInt(carryBpsPerDay) * BigInt(tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);

  const nonSeverityCosts = Number(capitalCharge + adverse + replication);

  // Target: markup * fairValue = E[Payout] + nonSeverityCosts
  // => E[Payout]_target = markup * fairValue - nonSeverityCosts
  const ePayout_target = markup * fairValue - nonSeverityCosts;

  if (ePayout_target <= 0) {
    // Non-severity costs already exceed the target; severity is irrelevant
    return 1;
  }

  // E[Payout] = Cap * p_hit * severity / PPM^2
  // => severity = E[Payout]_target * PPM^2 / (Cap * p_hit)
  const numerator = BigInt(Math.floor(ePayout_target)) * PPM_BI * PPM_BI;
  const denominator = cap * pHitPpm;

  if (denominator <= 0n) return 1;

  const severity = Number(numerator / denominator);

  // Clamp to reasonable range [1, PPM]
  return Math.max(1, Math.min(PPM, Math.round(severity)));
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Compute the heuristic premium as a plain number (for calibration and testing).
 * This is the clamped premium from computeQuote, returned as a single value.
 */
export function heuristicPremiumUsdc(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
): number {
  return computeQuote(capUsdc, template, pool, regime).premiumUsdc;
}
