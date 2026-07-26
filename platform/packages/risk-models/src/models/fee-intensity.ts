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
