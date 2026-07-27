/**
 * Stochastic fee intensity: empirical block bootstrap of the pool's daily
 * fee yield r_pool(t) = volume(t) × feeTier / TVL(t).
 *
 * Volume is strongly autocorrelated (regimes persist), so contiguous
 * blocks — not IID days — are resampled, philosophically matching the
 * price bootstrap. v1 samples rate paths independently of the price
 * paths; the volume–|return| coupling (which fattens yield tails in
 * high-vol scenarios) is a documented phase-2 extension of this seam.
 *
 * Deterministic under the run seed (FR-S4): same history + seed ⇒
 * bit-identical rate paths.
 */

import { makeRng } from "../rng";

export interface FeeIntensityParams {
  /** Historical daily rates (fraction/day, e.g. 0.0007 = 0.07%/day). */
  dailyRates: number[];
  meanRate: number;
  blockLength: number;
}

export function calibrateFeeIntensity(
  dailyRates: number[],
  opts?: { blockLength?: number; minObservations?: number },
): FeeIntensityParams {
  const minObs = opts?.minObservations ?? 60;
  const clean = dailyRates.filter((r) => Number.isFinite(r) && r >= 0);
  if (clean.length < minObs) {
    throw new Error(
      `fee-intensity needs ≥${minObs} daily observations, got ${clean.length}`,
    );
  }
  return {
    dailyRates: clean,
    meanRate: clean.reduce((s, r) => s + r, 0) / clean.length,
    blockLength: opts?.blockLength ?? 7,
  };
}

/**
 * Sample per-path daily-rate series: result[p][s] is the rate for the
 * interval ENDING at step s+1 (aligned with the engine's start-of-interval
 * accrual). Optional `rescaleToMean` pins the sampled mean to a target
 * level (used when the user overrides the level but wants fluctuations).
 */
export function sampleRatePaths(
  params: FeeIntensityParams,
  grid: { nPaths: number; steps: number; seed: number },
  opts?: { rescaleToMean?: number },
): number[][] {
  const { dailyRates, blockLength } = params;
  const rng = makeRng(grid.seed ^ 0x5eed_fee5); // decorrelate from price seed
  const scale =
    opts?.rescaleToMean !== undefined && params.meanRate > 0
      ? opts.rescaleToMean / params.meanRate
      : 1;

  const paths: number[][] = [];
  for (let p = 0; p < grid.nPaths; p++) {
    const path = new Array<number>(grid.steps);
    let s = 0;
    while (s < grid.steps) {
      const start = Math.floor(rng.uniform() * dailyRates.length);
      for (let b = 0; b < blockLength && s < grid.steps; b++, s++) {
        path[s] = dailyRates[(start + b) % dailyRates.length] * scale;
      }
    }
    paths.push(path);
  }
  return paths;
}

/**
 * Block-bootstrap ONE sequence of date indices into a common calendar of
 * `nObs` daily observations, shared by every pool in a portfolio.
 *
 * Fee income across pools co-moves: a market-wide volume regime lifts all
 * of them together. Sampling each pool's rate path from its own random
 * draws destroys that and understates portfolio fee dispersion; giving
 * every pool the same seed (as the single-pool path effectively did)
 * couples them by construction and overstates it. Reading every pool off
 * the SAME resampled dates reproduces whatever co-movement the record
 * actually showed — no correlation parameter is fitted and none is
 * assumed. It is the fee-side counterpart of the joint cross-asset
 * resampling the price bootstrap performs.
 *
 * Callers must align their per-pool series to this calendar first (take
 * the last `nObs` observations of each), so index i means the same day
 * for every pool.
 */
export function sampleSharedBlockIndices(grid: {
  nPaths: number;
  steps: number;
  seed: number;
  nObs: number;
  blockLength: number;
}): number[][] {
  const { nPaths, steps, seed, nObs } = grid;
  if (nObs < 1) throw new Error("sampleSharedBlockIndices: empty calendar");
  const bl = Math.max(1, Math.min(grid.blockLength, nObs));
  const rng = makeRng(seed ^ 0x5eed_fee5); // decorrelate from price seed
  const out: number[][] = [];
  for (let p = 0; p < nPaths; p++) {
    const row = new Array<number>(steps);
    let s = 0;
    while (s < steps) {
      const start = Math.floor(rng.uniform() * nObs);
      for (let b = 0; b < bl && s < steps; b++, s++) {
        row[s] = (start + b) % nObs;
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * Read one pool's rate paths off a shared index matrix. `dailyRates` must
 * already be aligned to the calendar the indices address.
 */
export function ratePathsFromIndices(
  dailyRates: number[],
  indices: number[][],
  opts?: { rescaleToMean?: number },
): number[][] {
  if (dailyRates.length === 0) throw new Error("ratePathsFromIndices: no rates");
  const mean = dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length;
  const scale =
    opts?.rescaleToMean !== undefined && mean > 0 ? opts.rescaleToMean / mean : 1;
  return indices.map((row) =>
    row.map((i) => dailyRates[i % dailyRates.length] * scale),
  );
}

// ── Phase 2: volume–|return| coupling ───────────────────────────────
// Volume spikes when prices move violently, so fee intensity should be
// conditioned on each path's own realized |returns| — this is what
// fattens yield tails in high-volatility scenarios. Model:
//   log r_pool(t) = α + β·|ret(t)| + ε(t),  ε block-bootstrapped.

export interface CoupledFeeIntensityParams {
  alpha: number;
  beta: number;
  /** Residual variation of log-rate, resampled in blocks. */
  residuals: number[];
  meanRate: number;
  blockLength: number;
}

export function calibrateCoupledFeeIntensity(
  dailyRates: number[],
  dailyReturns: number[],
  opts?: { blockLength?: number; minObservations?: number },
): CoupledFeeIntensityParams {
  const minObs = opts?.minObservations ?? 60;
  const n = Math.min(dailyRates.length, dailyReturns.length);
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = dailyRates[dailyRates.length - n + i];
    const ret = dailyReturns[dailyReturns.length - n + i];
    if (Number.isFinite(r) && r > 0 && Number.isFinite(ret)) {
      x.push(Math.abs(ret));
      y.push(Math.log(r));
    }
  }
  if (x.length < minObs) {
    throw new Error(
      `coupled fee-intensity needs ≥${minObs} aligned observations, got ${x.length}`,
    );
  }
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  const residuals = y.map((v, i) => v - (alpha + beta * x[i]));
  const rates = y.map((v) => Math.exp(v));
  return {
    alpha,
    beta,
    residuals,
    meanRate: rates.reduce((s, r) => s + r, 0) / rates.length,
    blockLength: opts?.blockLength ?? 7,
  };
}

/** Per-path |log returns| of one asset, aligned with the engine's
 *  interval convention (result[p][s] belongs to the interval ending at
 *  step s+1). */
export function absLogReturns(
  prices: number[][],
): number[][] {
  return prices.map((path) => {
    const out = new Array<number>(path.length - 1);
    for (let s = 1; s < path.length; s++) {
      out[s - 1] = Math.abs(Math.log(path[s] / path[s - 1]));
    }
    return out;
  });
}

/**
 * Sample rate paths CONDITIONED on each price path's own |returns|:
 *   rate[p][s] = exp(α + β·|ret[p][s]| + ε_block) , then optionally
 * rescaled so the sample mean equals `rescaleToMean` (level anchoring).
 */
export function sampleCoupledRatePaths(
  params: CoupledFeeIntensityParams,
  pathAbsReturns: number[][],
  grid: { seed: number },
  opts?: { rescaleToMean?: number },
): number[][] {
  const rng = makeRng(grid.seed ^ 0x5eed_fee5);
  const { residuals, blockLength } = params;
  const raw: number[][] = pathAbsReturns.map((rets) => {
    const path = new Array<number>(rets.length);
    let s = 0;
    while (s < rets.length) {
      const start = Math.floor(rng.uniform() * residuals.length);
      for (let b = 0; b < blockLength && s < rets.length; b++, s++) {
        path[s] = Math.exp(params.alpha + params.beta * rets[s] + residuals[(start + b) % residuals.length]);
      }
    }
    return path;
  });
  if (opts?.rescaleToMean === undefined) return raw;
  let sum = 0;
  let count = 0;
  for (const path of raw) for (const v of path) { sum += v; count++; }
  const mean = count > 0 ? sum / count : 0;
  if (mean <= 0) return raw;
  const scale = opts.rescaleToMean / mean;
  return raw.map((path) => path.map((v) => v * scale));
}
