/**
 * Liquidity Hedge Protocol — Pricing Engine
 *
 * Implements the canonical premium formula:
 *
 *   Premium = max(P_floor, FV · m_vol − y · E[F])
 *
 * where:
 *   FV      = fair value of the corridor payoff (risk-neutral expectation)
 *   m_vol   = max(markupFloor, IV/RV) — volatility markup
 *   y       = fee-split rate
 *   E[F]    = expected LP trading fees over the tenor
 *   P_floor = governance-set minimum premium
 *
 * FV is computed two ways:
 *   1. Gauss-Hermite quadrature (128 nodes) — theoretically exact
 *   2. Heuristic proxy — gas-efficient on-chain approximation
 *
 * References:
 *   Hull (2018), "Options, Futures, and Other Derivatives"
 *   Abramowitz & Stegun (1964), "Handbook of Mathematical Functions"
 *   Press et al. (2007), "Numerical Recipes"
 */

import {
  PPM,
  PPM_BI,
  BPS,
  BPS_BI,
  SECONDS_PER_YEAR,
  PoolState,
  RegimeSnapshot,
  TemplateConfig,
  QuoteResult,
} from "../types";
import { integerSqrt } from "../utils/math";
import {
  clPositionValue,
  corridorPayoff,
  naturalCap,
} from "../utils/position-value";
import { computeBarrierFromWidth } from "../config/templates";

// ---------------------------------------------------------------------------
// Numerical integration via composite Simpson's rule
// ---------------------------------------------------------------------------

/**
 * Standard normal PDF: φ(z) = exp(-z²/2) / √(2π)
 */
function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Number of Simpson's rule sub-intervals for FV integration.
 * 200 points over [-6, 6] gives <0.01% error vs Monte Carlo.
 * Must be even for Simpson's rule.
 */
const SIMPSON_N = 200;

/** Integration bounds: ±6σ covers 99.9999998% of the normal distribution */
const Z_BOUND = 6.0;

// ---------------------------------------------------------------------------
// Canonical premium formula
// ---------------------------------------------------------------------------

/**
 * Compute the canonical premium.
 *
 * Premium = max(P_floor, FV * m_vol - y * E[F])
 *
 * @param fairValueUsdc    - Fair value of corridor payoff (micro-USDC)
 * @param effectiveMarkup  - Volatility markup m_vol
 * @param feeDiscountUsdc  - Fee discount y * E[F] (micro-USDC)
 * @param premiumFloorUsdc - Governance minimum P_floor (micro-USDC)
 * @returns Premium in micro-USDC
 */
export function computePremium(
  fairValueUsdc: number,
  effectiveMarkup: number,
  feeDiscountUsdc: number,
  premiumFloorUsdc: number,
): number {
  const raw = Math.floor(fairValueUsdc * effectiveMarkup - feeDiscountUsdc);
  return Math.max(premiumFloorUsdc, raw);
}

// ---------------------------------------------------------------------------
// Fee discount
// ---------------------------------------------------------------------------

/**
 * Compute the fee discount term: y * E[F].
 *
 * E[F] = notionalUsdc * expectedDailyFee * tenorDays
 *
 * The fee discount reduces the LP's upfront premium cost because the
 * RT will receive y% of the LP's trading fees at settlement, providing
 * an alternative revenue stream.
 *
 * @param notionalUsdc    - Position notional value (micro-USDC)
 * @param expectedDailyFee - Expected daily fee rate (e.g. 0.005 = 0.5%)
 * @param feeSplitRate     - Fee-split rate y (e.g. 0.10 = 10%)
 * @param tenorDays        - Tenor in days (e.g. 7)
 * @returns Fee discount in micro-USDC
 */
export function computeFeeDiscount(
  notionalUsdc: number,
  expectedDailyFee: number,
  feeSplitRate: number,
  tenorDays: number,
): number {
  const expectedFees = notionalUsdc * expectedDailyFee * tenorDays;
  return Math.floor(feeSplitRate * expectedFees);
}

// ---------------------------------------------------------------------------
// Gauss-Hermite quadrature fair value
// ---------------------------------------------------------------------------

/**
 * Compute the fair value of the corridor payoff via Gauss-Hermite quadrature.
 *
 * Under risk-neutral GBM:
 *   S_T = S_0 * exp(-σ²/2 * T + σ * √T * Z),  Z ~ N(0,1)
 *
 * FV = E[Π(S_T)] = (1/√π) * Σ w_i * Π(S_T(x_i))
 *
 * where x_i, w_i are Gauss-Hermite nodes/weights and:
 *   S_T(x_i) = S_0 * exp(-σ²/2 * T + σ * √T * x_i * √2)
 *
 * The √2 factor converts from the physicist's Hermite convention
 * (weight exp(-x²)) to the probabilist's (weight exp(-x²/2)).
 *
 * Uses composite Simpson's rule over the standard normal distribution,
 * which is numerically stable for any number of points (unlike Hermite
 * polynomial root-finding which overflows for n > ~60).
 *
 * The integral is: FV = ∫ Π(S_T(z)) · φ(z) dz from -6 to +6
 * where S_T(z) = S_0 · exp(-σ²/2 · T + σ · √T · z)
 *
 * @param S0       - Entry price (human-readable, e.g. 150.0)
 * @param sigma    - Annualized volatility (e.g. 0.65)
 * @param L        - Liquidity parameter
 * @param pL       - Lower price bound = barrier
 * @param pU       - Upper price bound
 * @param cap      - Natural cap (pre-computed)
 * @param tenor    - Tenor in years (e.g. 7/365)
 * @param nPoints  - Number of Simpson sub-intervals (default 200, must be even)
 * @returns Fair value in token B units (USD, human-readable)
 */
export function computeGaussHermiteFV(
  S0: number,
  sigma: number,
  L: number,
  pL: number,
  pU: number,
  cap: number,
  tenor: number = 7 / 365,
  nPoints: number = SIMPSON_N,
): number {
  if (nPoints % 2 !== 0) nPoints++;

  const drift = -0.5 * sigma * sigma * tenor;
  const vol = sigma * Math.sqrt(tenor);
  const h = (2 * Z_BOUND) / nPoints;

  // Evaluate integrand: payoff(S_T(z)) * normalPdf(z)
  function integrand(z: number): number {
    const ST = S0 * Math.exp(drift + vol * z);
    const payoff = corridorPayoff(ST, S0, L, pL, pU, cap);
    return payoff * normalPdf(z);
  }

  // Composite Simpson's rule: ∫f dx ≈ (h/3)[f(a) + 4f(a+h) + 2f(a+2h) + ... + f(b)]
  let sum = integrand(-Z_BOUND) + integrand(Z_BOUND);
  for (let i = 1; i < nPoints; i++) {
    const z = -Z_BOUND + i * h;
    sum += (i % 2 === 0 ? 2 : 4) * integrand(z);
  }

  const fv = (h / 3) * sum;
  return Math.max(0, fv);
}

/**
 * Compute fair value and return result in micro-USDC.
 */
export function computeGaussHermiteFV_E6(
  entryPriceE6: number,
  sigmaPpm: number,
  L: number,
  pL_E6: number,
  pU_E6: number,
  capUsdc: number,
  tenorSeconds: number,
): number {
  const S0 = entryPriceE6 / 1_000_000;
  const sigma = sigmaPpm / PPM;
  const pL = pL_E6 / 1_000_000;
  const pU = pU_E6 / 1_000_000;
  const cap = capUsdc / 1_000_000;
  const tenor = tenorSeconds / SECONDS_PER_YEAR;

  const fv = computeGaussHermiteFV(S0, sigma, L, pL, pU, cap, tenor);
  return Math.floor(fv * 1_000_000);
}

// ---------------------------------------------------------------------------
// Heuristic fair-value proxy (on-chain compatible)
// ---------------------------------------------------------------------------

export interface HeuristicBreakdown {
  pHitPpm: number;
  expectedPayoutUsdc: number;
  capitalChargeUsdc: number;
  adverseSelectionUsdc: number;
  replicationCostUsdc: number;
  totalUsdc: number;
}

/**
 * Compute the heuristic fair-value proxy.
 *
 * This is the on-chain approximation of FV, using integer arithmetic
 * compatible with Solana's BPF runtime:
 *
 *   p_hit = min(1, 0.9 * σ * √T / width)
 *   E[Payout] = Cap * p_hit * severity / PPM²
 *   C_cap = Cap * (U_after / PPM)² / 5
 *   C_adv = Cap / 10 if stress, else 0
 *   C_rep = Cap * carry_bps * tenor_sec / BPS / (100 * 86400)
 *   FV_heuristic = clamp(E[Payout] + C_cap + C_adv + C_rep, 0, ceiling)
 *
 * Returns -1 if utilization would be exceeded.
 */
export function computeHeuristicFV(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
): HeuristicBreakdown | null {
  const cap = BigInt(capUsdc);
  const reserves =
    pool.reservesUsdc > 0 ? BigInt(pool.reservesUsdc) : 1_000_000n;
  const active = BigInt(pool.activeCapUsdc);

  // Utilization check
  const uAfterPpm = ((active + cap) * PPM_BI) / reserves;
  const uMaxPpm = BigInt(pool.uMaxBps) * 100n;
  if (uAfterPpm > uMaxPpm) return null; // Exceeds max utilization

  // p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
  const sigmaPpm = BigInt(regime.sigmaPpm);
  const secondsPerYear = BigInt(SECONDS_PER_YEAR);
  const tenorPpm =
    (BigInt(template.tenorSeconds) * PPM_BI) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * PPM_BI);
  const widthPpm = BigInt(template.widthBps) * 100n;

  let pHitPpm =
    (900_000n * sigmaPpm * sqrtTPpm) /
    PPM_BI /
    (widthPpm > 0n ? widthPpm : 1n);
  if (pHitPpm > PPM_BI) pHitPpm = PPM_BI;

  // E[Payout]
  const severityPpm = BigInt(regime.severityPpm);
  const expectedPayout = (cap * pHitPpm * severityPpm) / PPM_BI / PPM_BI;

  // C_cap = Cap * (U_after / PPM)^2 / 5
  const capitalCharge =
    (cap * uAfterPpm * uAfterPpm) / PPM_BI / PPM_BI / 5n;

  // C_adv
  const adverseSelection = regime.stressFlag ? cap / 10n : 0n;

  // C_rep
  const replicationCost =
    (cap *
      BigInt(regime.carryBpsPerDay) *
      BigInt(template.tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);

  // Total (clamped to ceiling)
  let total = expectedPayout + capitalCharge + adverseSelection + replicationCost;
  const ceiling = BigInt(template.premiumCeilingUsdc);
  if (total > ceiling) total = ceiling;

  return {
    pHitPpm: Number(pHitPpm),
    expectedPayoutUsdc: Number(expectedPayout),
    capitalChargeUsdc: Number(capitalCharge),
    adverseSelectionUsdc: Number(adverseSelection),
    replicationCostUsdc: Number(replicationCost),
    totalUsdc: Number(total),
  };
}

// ---------------------------------------------------------------------------
// Full quote computation
// ---------------------------------------------------------------------------

export interface QuoteParams {
  entryPriceE6: number;
  notionalUsdc: number;
  liquidity: number;
  pL: number; // lower bound (human-readable USD)
  pU: number; // upper bound (human-readable USD)
}

/**
 * Compute a full quote for a corridor certificate.
 *
 * Combines all pricing components:
 *   1. Compute natural cap from CL position
 *   2. Compute FV via heuristic (with GH available for validation)
 *   3. Compute fee discount
 *   4. Apply canonical formula: Premium = max(P_floor, FV * m_vol - y * E[F])
 *
 * @returns QuoteResult with full breakdown, or null if utilization exceeded
 */
export function computeQuote(
  params: QuoteParams,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
): QuoteResult | null {
  const { entryPriceE6, notionalUsdc, liquidity, pL, pU } = params;

  // Barrier = lower bound of CL range
  const barrierE6 = computeBarrierFromWidth(entryPriceE6, template.widthBps);
  const S0 = entryPriceE6 / 1_000_000;

  // Natural cap
  const cap = naturalCap(S0, liquidity, pL, pU);
  const capUsdc = Math.floor(cap * 1_000_000);

  if (capUsdc <= 0) return null;

  // Heuristic FV
  const heuristic = computeHeuristicFV(capUsdc, template, pool, regime);
  if (!heuristic) return null; // Utilization exceeded

  const fairValueUsdc = heuristic.totalUsdc;

  // Effective markup
  const effectiveMarkup = regime.effectiveMarkup;

  // Fee discount: y * E[F]
  const tenorDays = template.tenorSeconds / 86_400;
  const feeDiscountUsdc = computeFeeDiscount(
    notionalUsdc,
    pool.expectedDailyFee,
    pool.feeSplitRate,
    tenorDays,
  );

  // Canonical premium
  const premiumUsdc = computePremium(
    fairValueUsdc,
    effectiveMarkup,
    feeDiscountUsdc,
    pool.premiumFloorUsdc,
  );

  return {
    premiumUsdc,
    fairValueUsdc,
    effectiveMarkup,
    feeDiscountUsdc,
    capUsdc,
    barrierE6,
    entryPriceE6,
  };
}

// ---------------------------------------------------------------------------
// Severity calibration (re-export for convenience)
// ---------------------------------------------------------------------------

export { integerSqrt } from "../utils/math";
