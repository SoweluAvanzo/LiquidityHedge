/**
 * Return-correlation reporting, with the uncertainty attached.
 *
 * The joint simulator's whole claim is that portfolio dispersion carries
 * the assets' co-movement. That claim rests on an ESTIMATE, and an
 * estimate published without its error bar is a guess with a decimal
 * point. So every reported coefficient carries a sample size, a 95%
 * confidence interval and a two-sided p-value against H0: rho = 0.
 *
 * Method: Fisher's z-transform. For a sample correlation r on n paired
 * observations, z = artanh(r) is approximately normal with standard error
 * 1/sqrt(n-3), which gives both the interval and the test. The normal
 * approximation is accurate well below the sample sizes used here (a
 * 90-day window is the shortest the API accepts).
 *
 * IMPORTANT CAVEAT, surfaced to the user rather than buried: the interval
 * assumes independent observations. Daily crypto returns show volatility
 * clustering, so the EFFECTIVE sample size is smaller than n and the true
 * intervals are somewhat wider than reported. Treat them as a lower bound
 * on the uncertainty, not an upper one.
 */

import { normalCdf as phi } from "@lh/core/src/utils/normal";
import { AssetSeries, jointLogReturns } from "../model";

export interface CorrelationPair {
  /** Indices into `assetIds`. */
  i: number;
  j: number;
  /** Pearson correlation of aligned daily log returns. */
  r: number;
  /** Lower/upper bound of the 95% confidence interval (Fisher z). */
  ciLow: number;
  ciHigh: number;
  /** Two-sided p-value against H0: rho = 0. */
  pValue: number;
  /** True when the interval excludes zero at the 5% level. */
  significant: boolean;
}

export interface CorrelationReport {
  assetIds: string[];
  /** Full symmetric matrix, unit diagonal. */
  matrix: number[][];
  /** Paired observations the estimate is based on. */
  n: number;
  /** Off-diagonal pairs only (i < j), each with its uncertainty. */
  pairs: CorrelationPair[];
  /** Stated so the caller never has to guess what the numbers assume. */
  method: string;
}

// Φ comes from @lh/core so the workspace has exactly one implementation
// (see utils/normal.ts for why that matters). Re-exported here because
// this module's public surface already included it.
export { normalCdf } from "@lh/core/src/utils/normal";

/** Pearson correlation of two equal-length samples; 0 when either is flat. */
export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i] / n;
    my += y[i] / n;
  }
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > 0 ? sxy / denom : 0;
}

/**
 * Correlation matrix of the assets' aligned daily log returns, with a
 * confidence interval and p-value for every off-diagonal pair.
 */
export function correlationReport(history: AssetSeries[]): CorrelationReport {
  const assetIds = history.map((h) => h.assetId);
  const nAssets = assetIds.length;
  const returns = jointLogReturns(history); // steps × assets, tail-aligned
  const n = returns.length;

  // Column-major view: one return series per asset.
  const cols: number[][] = Array.from({ length: nAssets }, (_, a) =>
    returns.map((vec) => vec[a]),
  );

  const matrix: number[][] = Array.from({ length: nAssets }, (_, a) =>
    Array.from({ length: nAssets }, (_, b) => (a === b ? 1 : 0)),
  );
  const pairs: CorrelationPair[] = [];

  for (let a = 0; a < nAssets; a++) {
    for (let b = a + 1; b < nAssets; b++) {
      const r = pearson(cols[a], cols[b]);
      matrix[a][b] = r;
      matrix[b][a] = r;

      // Fisher z: artanh(r) ~ N(artanh(rho), 1/(n-3)).
      let ciLow = -1;
      let ciHigh = 1;
      let pValue = 1;
      if (n > 3 && Math.abs(r) < 1) {
        const z = Math.atanh(r);
        const se = 1 / Math.sqrt(n - 3);
        ciLow = Math.tanh(z - 1.959963985 * se);
        ciHigh = Math.tanh(z + 1.959963985 * se);
        pValue = 2 * (1 - phi(Math.abs(z) / se));
      } else if (Math.abs(r) >= 1) {
        // Degenerate: identical (or perfectly opposed) series.
        ciLow = r;
        ciHigh = r;
        pValue = 0;
      }
      pairs.push({
        i: a,
        j: b,
        r,
        ciLow,
        ciHigh,
        pValue,
        significant: ciLow > 0 || ciHigh < 0,
      });
    }
  }

  return {
    assetIds,
    matrix,
    n,
    pairs,
    method:
      "Pearson correlation of aligned daily log returns; 95% CI and " +
      "two-sided p-value by Fisher z-transform. Intervals assume " +
      "independent observations — volatility clustering makes the " +
      "effective sample smaller, so the true intervals are somewhat wider.",
  };
}
