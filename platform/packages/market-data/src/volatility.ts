/**
 * Realized volatility from close-to-close log returns, annualized with the
 * 365-day convention (matches the prototype and docs §5.1).
 *
 * Unlike the prototype's computeVolatility, this REFUSES degraded input
 * instead of substituting a hardcoded default sigma (§E7): callers decide
 * what to do with `null`.
 */

import { Candle, CoverageReport, Timeframe, TIMEFRAME_SECONDS } from "./types";

const SECONDS_PER_YEAR = 365 * 86_400;

export interface RealizedVol {
  /** Annualized volatility, e.g. 0.62 = 62%. */
  sigma: number;
  nReturns: number;
  windowSeconds: number;
}

export function computeRealizedVol(
  candles: Candle[],
  timeframe: Timeframe,
  opts?: { minReturns?: number },
): RealizedVol | null {
  const minReturns = opts?.minReturns ?? 30;
  if (candles.length < minReturns + 1) return null;

  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].c;
    const cur = candles[i].c;
    if (!(prev > 0) || !(cur > 0)) return null; // corrupt data → refuse
    returns.push(Math.log(cur / prev));
  }

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) /
    (returns.length - 1);

  const stepSeconds = TIMEFRAME_SECONDS[timeframe];
  const periodsPerYear = SECONDS_PER_YEAR / stepSeconds;
  return {
    sigma: Math.sqrt(variance * periodsPerYear),
    nReturns: returns.length,
    windowSeconds: candles[candles.length - 1].t - candles[0].t,
  };
}

/**
 * Guarded variant: refuses to compute vol on incomplete ingestion.
 * This is the only entry point the regime updater is allowed to use.
 */
export function computeRealizedVolGuarded(
  candles: Candle[],
  timeframe: Timeframe,
  coverage: CoverageReport,
): RealizedVol {
  if (!coverage.complete) {
    throw new Error(
      `realized vol refused: coverage ${(coverage.coverageRatio * 100).toFixed(1)}% ` +
        `(${coverage.received}/${coverage.expected} candles, ${coverage.gaps} gaps) — ` +
        `degraded data must not silently feed pricing (§E7)`,
    );
  }
  const rv = computeRealizedVol(candles, timeframe);
  if (!rv) {
    throw new Error("realized vol refused: insufficient or corrupt candles");
  }
  return rv;
}
