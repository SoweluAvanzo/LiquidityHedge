/**
 * Deterministic moving-block bootstrap utilities (§1.4 σ band, §1.5
 * empirical in-range interval).
 *
 * Blocks preserve serial dependence (volatility clustering, rolling-
 * window overlap) that an iid resample or a χ² interval would wash
 * out. Everything is SEEDED: the regression harness diffs served
 * numbers, so an interval must never move without an input moving.
 */

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Means of moving-block resamples of `series` — `resamples` values,
 * deterministic under `seed`. Block length is clamped to the series
 * length; callers pick it ≥ the dependence length of their series.
 */
export function movingBlockResampleMeans(
  series: number[],
  opts: { blockLength: number; resamples: number; seed: number },
): number[] {
  const n = series.length;
  const b = Math.min(opts.blockLength, n);
  const rng = mulberry32(opts.seed);
  const means: number[] = [];
  for (let r = 0; r < opts.resamples; r++) {
    let sum = 0;
    let count = 0;
    while (count < n) {
      const start = Math.floor(rng() * (n - b + 1));
      for (let j = 0; j < b && count < n; j++, count++) {
        sum += series[start + j];
      }
    }
    means.push(sum / n);
  }
  return means;
}

/** p-quantile of a SORTED array, floor-index convention. */
export function quantileSortedFloor(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
