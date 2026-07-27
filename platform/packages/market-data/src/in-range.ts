/**
 * Empirical in-range estimators — real-data replacements for the GBM
 * `inRangeFraction` used by the viability index.
 *
 * Two distinct questions, two estimators:
 *
 * 1. realizedInRangeFraction — DESCRIPTIVE, fixed absolute range: what
 *    fraction of the observed window was the price inside [pL, pU]?
 *    Valid for ranges that existed over that window (e.g. a held
 *    position). BIASED as a forward estimate for a range centered at
 *    today's price (it is in range now by construction).
 *
 * 2. empiricalInRangeFraction — FORWARD-LOOKING, relative width: for a
 *    range of width ±w centered at the price where each rolling
 *    historical window BEGINS, what fraction of the following horizon
 *    stayed in range? Averaged over all windows this is the unbiased
 *    empirical analogue of the GBM estimate (and converges to it when
 *    prices really are GBM — see the cross-validation test).
 */

import { Candle } from "./types";
import { movingBlockResampleMeans, quantileSortedFloor } from "./bootstrap";

export interface RealizedInRange {
  /** Close-price indicator estimate. */
  fraction: number;
  /** OHLC-overlap-weighted estimate (within-candle refinement). */
  weightedFraction: number;
  observations: number;
}

export function realizedInRangeFraction(
  candles: Candle[],
  priceLower: number,
  priceUpper: number,
): RealizedInRange {
  if (!(priceUpper > priceLower)) {
    throw new Error(`invalid range [${priceLower}, ${priceUpper}]`);
  }
  if (candles.length === 0) {
    return { fraction: 0, weightedFraction: 0, observations: 0 };
  }
  let inCount = 0;
  let weighted = 0;
  for (const c of candles) {
    if (c.c >= priceLower && c.c <= priceUpper) inCount++;
    const lo = Math.min(c.l, c.h);
    const hi = Math.max(c.l, c.h);
    if (hi === lo) {
      weighted += lo >= priceLower && lo <= priceUpper ? 1 : 0;
    } else {
      const overlap = Math.max(0, Math.min(hi, priceUpper) - Math.max(lo, priceLower));
      weighted += overlap / (hi - lo);
    }
  }
  return {
    fraction: inCount / candles.length,
    weightedFraction: weighted / candles.length,
    observations: candles.length,
  };
}

export interface EmpiricalInRangeResult {
  /** Mean over all rolling windows — the headline estimate. */
  mean: number;
  /** OUTCOME distribution across windows (how a single realized window
   *  can land) — NOT the precision of `mean`; that is `meanCi`. */
  p05: number;
  p50: number;
  p95: number;
  /** Raw rolling-window count. Windows overlap horizonSteps−1 of
   *  horizonSteps days, so this OVERSTATES the evidence ~horizonSteps-
   *  fold; quote `nEffective` next to any interval (§1.5). */
  windows: number;
  horizonSteps: number;
  /**
   * 90% moving-block bootstrap CI for `mean` itself — the number the
   * yield chain actually consumes. Blocks span 2× the horizon so the
   * window overlap cannot fake independence. Seeded/deterministic.
   */
  meanCi: { p05: number; p95: number };
  /** windows / horizonSteps, the honest independent-evidence count. */
  nEffective: number;
}

/**
 * Empirical in-range fraction for a range at its ACTUAL position relative
 * to spot, rather than a ±w band re-centred on each window's open.
 *
 * The width-based form below asks "how often does a band around spot hold
 * the price". For a position whose range does not straddle spot that is a
 * question about a different range: all four live positions sat entirely
 * below their own ranges and were still credited with 86% in-range time.
 * That fraction multiplies straight into measured fee yield, the numerator
 * of both viability indices.
 *
 * Fix: carry the range's MULTIPLICATIVE offsets from spot into each
 * window, so window i tests [close_i·(pL/S0), close_i·(pU/S0)]. Same
 * rolling-window estimator, same windows, no new assumptions — it simply
 * stops assuming the position is centred where the price is now.
 */
export function empiricalInRangeFractionBounds(
  closes: number[],
  priceLower: number,
  priceUpper: number,
  spot: number,
  horizonSteps: number,
): EmpiricalInRangeResult {
  if (!(spot > 0) || !(priceLower > 0) || !(priceUpper > priceLower)) {
    throw new Error(
      `invalid range [${priceLower}, ${priceUpper}] at spot ${spot}`,
    );
  }
  if (horizonSteps < 1) throw new Error("horizonSteps must be >= 1");
  const nWindows = closes.length - horizonSteps;
  if (nWindows < 1) {
    throw new Error(
      `history too short: ${closes.length} closes for horizon ${horizonSteps}`,
    );
  }
  const loMul = priceLower / spot;
  const hiMul = priceUpper / spot;
  const fractions: number[] = new Array(nWindows);
  for (let i = 0; i < nWindows; i++) {
    const lower = closes[i] * loMul;
    const upper = closes[i] * hiMul;
    let inCount = 0;
    for (let st = 1; st <= horizonSteps; st++) {
      const p = closes[i + st];
      if (p >= lower && p <= upper) inCount++;
    }
    fractions[i] = inCount / horizonSteps;
  }
  return summariseFractions(fractions, horizonSteps);
}

export function empiricalInRangeFraction(
  closes: number[],
  widthBps: number,
  horizonSteps: number,
): EmpiricalInRangeResult {
  if (widthBps <= 0 || widthBps >= 10_000) {
    throw new Error(`widthBps ${widthBps} out of (0, 10000)`);
  }
  if (horizonSteps < 1) throw new Error("horizonSteps must be ≥ 1");
  const nWindows = closes.length - horizonSteps;
  if (nWindows < 1) {
    throw new Error(
      `history too short: ${closes.length} closes for horizon ${horizonSteps}`,
    );
  }
  const w = widthBps / 10_000;
  const fractions: number[] = new Array(nWindows);
  for (let i = 0; i < nWindows; i++) {
    const lower = closes[i] * (1 - w);
    const upper = closes[i] * (1 + w);
    let inCount = 0;
    for (let s = 1; s <= horizonSteps; s++) {
      const p = closes[i + s];
      if (p >= lower && p <= upper) inCount++;
    }
    fractions[i] = inCount / horizonSteps;
  }
  return summariseFractions(fractions, horizonSteps);
}

/** Shared summary so both estimators report identically. */
function summariseFractions(
  fractions: number[],
  horizonSteps: number,
): EmpiricalInRangeResult {
  const nWindows = fractions.length;
  const sorted = [...fractions].sort((a, b) => a - b);
  const q = (p: number) => {
    const pos = p * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  // §1.5: interval for the MEAN via moving-block bootstrap. Adjacent
  // window fractions share horizonSteps−1 of horizonSteps observations;
  // blocks of 2×horizonSteps keep that dependence inside blocks, so the
  // interval reflects ~windows/horizonSteps independent observations
  // rather than pretending to `windows` of them.
  const means = movingBlockResampleMeans(fractions, {
    blockLength: 2 * horizonSteps,
    resamples: 400,
    seed: 0x5eed15,
  }).sort((a, b) => a - b);
  return {
    mean: fractions.reduce((s, f) => s + f, 0) / nWindows,
    p05: q(0.05),
    p50: q(0.5),
    p95: q(0.95),
    windows: nWindows,
    horizonSteps,
    meanCi: {
      p05: quantileSortedFloor(means, 0.05),
      p95: quantileSortedFloor(means, 0.95),
    },
    nEffective: Math.max(1, Math.round(nWindows / horizonSteps)),
  };
}
