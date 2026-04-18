/**
 * Pricing operations for the Liquidity Hedge Protocol v3.
 *
 * v3 pricing is radically simplified compared to v2:
 *
 *   Premium = FairValue * max(markupFloor, IV/RV) * coverRatio - feeSplitRate * E[weeklyFees]
 *
 * The LP sees exactly 3 numbers plus a fee discount:
 *   1. FairValue -- the no-arbitrage expected payout (from GH quadrature or heuristic)
 *   2. Effective markup -- max(floor, IV/RV), sourced from option markets
 *   3. Cover ratio -- LP's choice of how much of the natural cap to hedge
 *   4. Fee discount -- feeSplitRate * expectedWeeklyFees (reduces upfront cost)
 *
 * Removed from v2:
 * - Two-part premium (alpha/beta split)
 * - Vol indicator (sigma_7d / sigma_30d scaling)
 * - Separate calibrateSeverity solver (severity is still dynamic but simpler)
 * - Performance fee (replaced by fee-split model)
 *
 * Added in v3:
 * - coverRatio scaling in premium and payout
 * - Fee split: RT receives feeSplitRate% of actual LP fees at settlement
 * - Fee discount on premium: feeSplitRate * E[weeklyFees] subtracted from upfront cost
 * - Derived severity from effectiveMarkup (no separate calibration loop)
 */

import {
  PoolState,
  RegimeSnapshot,
  TemplateConfig,
  QuoteBreakdown,
  PPM,
  BPS,
  PPM_BI,
  BPS_BI,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_COVER_RATIO,
} from "../types";

// ─── Integer Square Root (from math.rs) ──────────────────────────────

/** Newton's method integer sqrt -- identical to programs/lh-core/src/math.rs */
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

// ─── Effective Markup ───────────────────────────────────────────────

/**
 * Resolve the effective markup for premium pricing.
 *
 * effectiveMarkup = max(markupFloor, ivRvRatio)
 *
 * If regime already has effectiveMarkup set, use it directly.
 * Otherwise compute from the floor and ivRvRatio.
 *
 * @param ivRvRatio   Implied vol / realized vol from option markets
 * @param markupFloor Minimum markup (default: DEFAULT_MARKUP_FLOOR = 1.05)
 * @returns Effective markup (>= 1.0)
 */
export function resolveEffectiveMarkup(
  ivRvRatio: number,
  markupFloor: number = DEFAULT_MARKUP_FLOOR,
): number {
  return Math.max(markupFloor, ivRvRatio);
}

export interface MarkupComponentsInput {
  ivRvRatio: number;
  markupFloor?: number;
  utilizationPpm?: number;
  utilizationRiskWeightPpm?: number;
  stressFlag?: boolean;
  stressMarkupAddOnPpm?: number;
  maxMarkup?: number;
}

export interface MarkupComponents {
  baseMarkup: number;
  utilizationAddOn: number;
  stressAddOn: number;
  effectiveMarkup: number;
}

/**
 * Compute decomposed effective markup with optional utilization/stress add-ons.
 * This keeps v3's max(floor, IV/RV) core while allowing governance-controlled
 * risk loading components used in policy optimization and stress regimes.
 */
export function resolveEffectiveMarkupDetailed(
  input: MarkupComponentsInput,
): MarkupComponents {
  const floor = input.markupFloor ?? DEFAULT_MARKUP_FLOOR;
  const utilizationPpm = Math.max(0, Math.min(PPM, input.utilizationPpm ?? 0));
  const utilWeightPpm = Math.max(0, input.utilizationRiskWeightPpm ?? 0);
  const stressAddOnPpm = Math.max(0, input.stressMarkupAddOnPpm ?? 0);
  const maxMarkup = Math.max(floor, input.maxMarkup ?? Number.POSITIVE_INFINITY);

  const baseMarkup = Math.max(floor, input.ivRvRatio);
  const utilizationAddOn = (utilizationPpm / PPM) * (utilWeightPpm / PPM);
  const stressAddOn = input.stressFlag ? stressAddOnPpm / PPM : 0;
  const effectiveMarkup = Math.min(maxMarkup, baseMarkup + utilizationAddOn + stressAddOn);

  return { baseMarkup, utilizationAddOn, stressAddOn, effectiveMarkup };
}

// ─── v3 Premium Formula ─────────────────────────────────────────────

/**
 * Compute the v3 premium with fee-split discount.
 *
 * Premium = FairValue * effectiveMarkup * coverRatio - feeSplitRate * E[weeklyFees]
 *
 * The fee discount reflects that the RT will receive feeSplitRate% of actual
 * LP fees at settlement, creating a lower upfront cost for the LP.
 *
 * @param fairValueUsdc            No-arbitrage fair value (micro-USDC)
 * @param effectiveMarkup          max(floor, IV/RV)
 * @param coverRatio               LP's chosen cover ratio (0.25 to 1.00)
 * @param feeSplitRate             Fraction of LP fees flowing to RT (default 0)
 * @param expectedWeeklyFeesUsdc   Expected weekly fee income in micro-USDC (default 0)
 * @returns Premium in micro-USDC (floored at $0.05 = 50,000 micro-USDC)
 */
export function computeV3Premium(
  fairValueUsdc: number,
  effectiveMarkup: number,
  coverRatio: number,
  feeSplitRate: number = 0,
  expectedWeeklyFeesUsdc: number = 0,
): number {
  const fullPremium = fairValueUsdc * effectiveMarkup * coverRatio;
  const feeDiscount = feeSplitRate * expectedWeeklyFeesUsdc;
  return Math.max(50_000, Math.floor(fullPremium - feeDiscount)); // floor at $0.05
}

// ─── v3 Payout Formula ──────────────────────────────────────────────

/**
 * Scale a full corridor payout by the cover ratio.
 *
 * @param fullPayoutUsdc  Full corridor loss payout (micro-USDC)
 * @param coverRatio      LP's cover ratio
 * @returns Scaled payout in micro-USDC
 */
export function computeV3Payout(
  fullPayoutUsdc: number,
  coverRatio: number,
): number {
  return Math.floor(fullPayoutUsdc * coverRatio);
}

// ─── RT Fee Income (Fee Split) ─────────────────────────────────────

/**
 * Compute the RT's fee income from the fee-split mechanism.
 *
 * At settlement, the RT receives feeSplitRate% of the LP's actual
 * trading fees accrued during the tenor. This provides income
 * diversification for the RT: fee income is correlated with LP
 * activity, not with claims.
 *
 * @param actualFeesUsdc  Actual LP fees accrued during the tenor (micro-USDC)
 * @param feeSplitRate    Fraction of fees flowing to RT (e.g. 0.10 = 10%)
 * @returns RT fee income in micro-USDC
 */
export function computeRtFeeIncome(
  actualFeesUsdc: number,
  feeSplitRate: number,
): number {
  return Math.floor(actualFeesUsdc * feeSplitRate);
}

// ─── Heuristic Premium (on-chain compatible) ────────────────────────

/**
 * Compute the heuristic premium components in integer arithmetic.
 *
 * This is the on-chain-compatible formula, identical to v1/v2
 * but reading severityPpm from the regime snapshot.
 *
 * Formula:
 *   E[Payout] = Cap * p_hit(sigma, T, width) * severity / PPM^2
 *   C_cap     = Cap * (U_after / PPM)^2 / 5
 *   C_adv     = Cap / 10 if stress, else 0
 *   C_rep     = Cap * carry_bps * tenor_seconds / BPS / (100 * 86400)
 *
 * @returns Components and unclamped total (all as bigint).
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

  // C_rep (replication cost) -- prorated to seconds
  const replication =
    (cap * BigInt(regime.carryBpsPerDay) * BigInt(template.tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);

  const unclamped = expectedPayout + capitalCharge + adverse + replication;

  return { expectedPayout, capitalCharge, adverse, replication, unclamped, uAfterPpm };
}

// ─── Heuristic Premium (clamped, for on-chain compatibility) ────────

/**
 * Compute the heuristic premium with cover ratio scaling.
 *
 * This is the on-chain-compatible path. The heuristic serves as
 * a fallback or cross-check for the simpler v3 formula. In the
 * heuristic path, cover ratio simply scales the final premium.
 *
 * @param capUsdc     Scaled cap (= naturalCap * coverRatio)
 * @param template    Template configuration
 * @param pool        Current pool state
 * @param regime      Current regime snapshot (with severity and effectiveMarkup)
 * @param coverRatio  LP's cover ratio (used for scaling)
 * @returns Heuristic premium in micro-USDC, or -1 if utilization exceeded
 */
export function computeHeuristicPremium(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
  coverRatio: number = DEFAULT_COVER_RATIO,
): number {
  const cap = Math.round(capUsdc * 1e6);
  const res = Math.max(1, Math.round(pool.reservesUsdc * 1e6));
  const act = Math.round(pool.activeCapUsdc * 1e6);
  const uAfter = Number((BigInt(act + cap) * BigInt(PPM)) / BigInt(res));
  const uMax = pool.uMaxBps * 100;
  if (uAfter > uMax) return -1; // exceeds utilization

  const sPpm = regime.sigmaPpm;
  const tPpm = Number((BigInt(7 * 86400) * BigInt(PPM)) / BigInt(365 * 86400));
  const sqT = Number(integerSqrt(BigInt(tPpm) * BigInt(PPM)));
  const wPpm = template.widthBps * 100;
  const pHit = Math.min(PPM, Math.floor(900000 * sPpm * sqT / PPM / Math.max(wPpm, 1)));

  const severityPpm = regime.severityPpm || 400000;

  const ePay = Math.floor(cap * pHit * severityPpm / PPM / PPM);
  const cCap = Math.floor(cap * uAfter * uAfter / PPM / PPM / 5);
  const cAdv = regime.stressFlag ? Math.floor(cap / 10) : 0;
  const cRep = Math.floor(cap * regime.carryBpsPerDay * 7 * 86400 / BPS / 100 / 86400);

  let premium = ePay + cCap + cAdv + cRep;
  premium = Math.max(
    Math.round(template.premiumFloorUsdc * 1e6),
    Math.min(Math.round(template.premiumCeilingUsdc * 1e6), premium),
  );

  return premium / 1e6;
}

// ─── Full Quote (diagnostic) ────────────────────────────────────────

/**
 * Compute a full quote breakdown using the heuristic formula.
 *
 * The heuristic premium serves as the "fair value proxy" for the v3
 * pricing formula. The full v3 premium is:
 *   premium = heuristicFairValue * effectiveMarkup * coverRatio
 *
 * This function returns the full breakdown for transparency.
 *
 * @param naturalCapUsdc  Natural cap before cover ratio (micro-USDC)
 * @param template        Template configuration
 * @param pool            Current pool state
 * @param regime          Current regime snapshot
 * @param coverRatio      LP's cover ratio (0.25 to 1.00)
 * @returns Full quote breakdown
 */
export function computeQuote(
  naturalCapUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
  coverRatio: number = DEFAULT_COVER_RATIO,
): QuoteBreakdown {
  // Validate cover ratio
  const cr = Math.max(0.25, Math.min(1.0, coverRatio));

  // Scaled cap for the pool
  const scaledCapUsdc = Math.floor(naturalCapUsdc * cr);

  // Compute heuristic components on the SCALED cap
  const {
    expectedPayout,
    capitalCharge,
    adverse,
    replication,
    unclamped,
  } = computeHeuristicComponents(scaledCapUsdc, template, pool, regime);

  // Clamp to [floor, ceiling]
  const floor = BigInt(template.premiumFloorUsdc);
  const ceiling = BigInt(template.premiumCeilingUsdc);
  let fairValueBig = unclamped;
  if (fairValueBig < floor) fairValueBig = floor;
  if (fairValueBig > ceiling) fairValueBig = ceiling;

  const fairValueUsdc = Number(fairValueBig);

  // v3 effective markup (with optional utilization/stress decomposition)
  const reserves = Math.max(1, pool.reservesUsdc);
  const utilizationPpm = Math.floor(((pool.activeCapUsdc + scaledCapUsdc) * PPM) / reserves);
  const effectiveMarkup = regime.effectiveMarkup || resolveEffectiveMarkupDetailed({
    ivRvRatio: regime.ivRvRatio || 0,
    markupFloor: pool.markupFloor,
    utilizationPpm,
    utilizationRiskWeightPpm: pool.utilizationRiskWeightPpm,
    stressFlag: regime.stressFlag,
    stressMarkupAddOnPpm: pool.stressMarkupAddOnPpm,
    maxMarkup: pool.maxMarkup,
  }).effectiveMarkup;

  // v3 premium = fairValue * effectiveMarkup (coverRatio already baked into scaledCap)
  const premiumUsdc = Math.floor(fairValueUsdc * effectiveMarkup);

  return {
    fairValueUsdc,
    effectiveMarkup,
    coverRatio: cr,
    premiumUsdc,
    capUsdc: scaledCapUsdc,
    expectedPayoutUsdc: Number(expectedPayout),
    capitalChargeUsdc: Number(capitalCharge),
    adverseSelectionUsdc: Number(adverse),
    replicationCostUsdc: Number(replication),
  };
}

// ─── Severity Calibration ───────────────────────────────────────────

/**
 * Calibrate severityPpm so the heuristic premium approximates
 * effectiveMarkup * fairValue.
 *
 * In v3, the effectiveMarkup is derived from IV/RV, so severity
 * is calibrated to make the heuristic track fair value (without markup).
 * The markup is then applied multiplicatively on top.
 *
 * severity = (FV_target - C_cap - C_adv - C_rep) * PPM^2 / (Cap * p_hit)
 *
 * @param sigmaPpm        Current annualized sigma in PPM
 * @param widthBps        Position width in basis points
 * @param capUsdc         Reference cap for calibration
 * @param tenorSeconds    Certificate tenor in seconds
 * @param pool            Pool state (for utilization)
 * @param stressFlag      Whether stress conditions apply
 * @param carryBpsPerDay  Carry cost rate
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
): number {
  const cap = BigInt(capUsdc);

  // Compute p_hit
  const secondsPerYear = 365n * 86_400n;
  const tenorPpm = (BigInt(tenorSeconds) * PPM_BI) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * PPM_BI);
  const widthPpmBig = BigInt(widthBps) * 100n;

  let pHitPpm =
    (900_000n * BigInt(sigmaPpm) * sqrtTPpm) /
    PPM_BI /
    (widthPpmBig > 0n ? widthPpmBig : 1n);
  if (pHitPpm > PPM_BI) pHitPpm = PPM_BI;

  if (pHitPpm <= 0n) return 1;

  // Fair value proxy: Cap * p_hit * (width/2) / PPM
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
  const replicationCost =
    (cap * BigInt(carryBpsPerDay) * BigInt(tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);

  const nonSeverityCosts = Number(capitalCharge + adverse + replicationCost);

  // Target: fair value = E[Payout] + nonSeverityCosts
  // => E[Payout]_target = fairValue - nonSeverityCosts
  const ePayoutTarget = fairValue - nonSeverityCosts;

  if (ePayoutTarget <= 0) return 1;

  // E[Payout] = Cap * p_hit * severity / PPM^2
  // => severity = E[Payout]_target * PPM^2 / (Cap * p_hit)
  const numerator = BigInt(Math.floor(ePayoutTarget)) * PPM_BI * PPM_BI;
  const denominator = cap * pHitPpm;

  if (denominator <= 0n) return 1;

  const severity = Number(numerator / denominator);

  return Math.max(1, Math.min(PPM, Math.round(severity)));
}
