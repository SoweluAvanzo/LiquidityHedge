/**
 * Realized volatility from close-to-close log returns, annualized with the
 * 365-day convention (matches the prototype and docs §5.1).
 *
 * Unlike the prototype's computeVolatility, this REFUSES degraded input
 * instead of substituting a hardcoded default sigma (§E7): callers decide
 * what to do with `null`.
 */

import { Candle, CoverageReport, Timeframe, TIMEFRAME_SECONDS } from "./types";
import { movingBlockResampleMeans, quantileSortedFloor } from "./bootstrap";

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

// ── OHLC (Garman–Klass) estimator with its own uncertainty (§1.4) ─────

export interface OhlcRealizedVol {
  /** Annualized volatility, e.g. 0.44 = 44%. */
  sigma: number;
  /** 90% interval for σ itself (p05/p95), from a seeded moving-block
   *  bootstrap over the daily variance contributions — blocks preserve
   *  volatility clustering that an iid χ² interval would ignore. */
  band: { p05: number; p95: number };
  nDays: number;
  windowSeconds: number;
  method: "garman-klass";
}

/**
 * Garman–Klass (1980) realized volatility from OHLC bars:
 *
 *   σ²_bar = 0.5·ln(H/L)² − (2ln2 − 1)·ln(C/O)²
 *
 * ~7.4× more efficient than close-to-close at the same sample size —
 * 30 days of OHLC buys the precision of ~200 days of closes — using
 * the high/low/open the ingestion already fetches and the CC estimator
 * discards. Zero-drift assumption; suited to 24/7 markets where each
 * open equals the previous close (no overnight-gap term needed).
 * Given valid OHLC (O, C ∈ [L, H]) each bar contribution is ≥ 0
 * (|ln(C/O)| ≤ ln(H/L) and 0.5 − (2ln2−1) > 0).
 *
 * Refuses (null) on corrupt bars — H < L, non-positive prices, or O/C
 * outside [L, H] — rather than skipping them: a silently cleaned series
 * is a different estimand (§E7 policy). Callers fall back to the
 * close-to-close estimator, LABELLED.
 */
export function computeGarmanKlassVol(
  candles: Candle[],
  timeframe: Timeframe,
  opts?: {
    minCandles?: number;
    bootstrap?: { resamples?: number; blockLength?: number; seed?: number };
  },
): OhlcRealizedVol | null {
  const minCandles = opts?.minCandles ?? 30;
  if (candles.length < minCandles) return null;

  const K = 2 * Math.LN2 - 1;
  const contributions: number[] = [];
  for (const bar of candles) {
    const { o, h, l, c } = bar;
    if (!(l > 0) || !(h >= l) || !(o > 0) || !(c > 0)) return null;
    // Tolerate vendor rounding at the 1e-6 level, refuse real violations.
    if (o < l * (1 - 1e-6) || o > h * (1 + 1e-6)) return null;
    if (c < l * (1 - 1e-6) || c > h * (1 + 1e-6)) return null;
    const hl = Math.log(h / l);
    const co = Math.log(c / o);
    contributions.push(0.5 * hl * hl - K * co * co);
  }

  const stepSeconds = TIMEFRAME_SECONDS[timeframe];
  const periodsPerYear = SECONDS_PER_YEAR / stepSeconds;
  const mean = contributions.reduce((s, x) => s + x, 0) / contributions.length;
  if (!(mean > 0)) return null; // flat/degenerate series — no vol estimate
  const sigma = Math.sqrt(mean * periodsPerYear);

  // Moving-block bootstrap on the per-bar variance contributions.
  const sigmas = movingBlockResampleMeans(contributions, {
    blockLength: opts?.bootstrap?.blockLength ?? 5,
    resamples: opts?.bootstrap?.resamples ?? 400,
    seed: opts?.bootstrap?.seed ?? 0x1e35a7,
  })
    .map((m) => Math.sqrt(Math.max(0, m) * periodsPerYear))
    .sort((a, b) => a - b);

  return {
    sigma,
    band: {
      p05: quantileSortedFloor(sigmas, 0.05),
      p95: quantileSortedFloor(sigmas, 0.95),
    },
    nDays: candles.length,
    windowSeconds:
      candles.length > 0 ? candles[candles.length - 1].t - candles[0].t + stepSeconds : 0,
    method: "garman-klass",
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
