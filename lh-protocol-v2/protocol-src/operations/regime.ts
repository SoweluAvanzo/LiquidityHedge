/**
 * Regime management: update market regime snapshot with dynamic severity calibration.
 *
 * The regime snapshot captures current market conditions (volatility, stress,
 * carry cost) and auto-calibrates severityPpm so the heuristic premium
 * tracks markup * fair_value under changing sigma.
 *
 * v2 introduces:
 * - severityPpm is stored in RegimeSnapshot (not TemplateConfig)
 * - Automatic recalibration on every regime update
 * - Vol indicator (sigma_7d / sigma_30d) for two-part premium scaling
 *
 * The regime update is intended to be called by the off-chain risk service
 * every 15 minutes (REGIME_MAX_AGE_S = 900s) using Birdeye OHLCV data.
 */

import {
  RegimeSnapshot,
  RegimeParams,
  PoolState,
  TemplateConfig,
  PPM,
  DEFAULT_MARKUP,
  DEFAULT_MARKUP_FLOOR,
} from "../types";
import { calibrateSeverity, computeVolIndicator } from "./pricing";
import { DEFAULT_REGIME_SEVERITY } from "../config/templates";

// ─── State Store Interface ───────────────────────────────────────────

export interface RegimeStore {
  getPool(): PoolState | null;
  getRegime(): RegimeSnapshot | null;
  setRegime(regime: RegimeSnapshot): void;
  getAllTemplates(): TemplateConfig[];
}

// ─── Regime Update ───────────────────────────────────────────────────

/**
 * Update the regime snapshot with fresh market data and auto-calibrated severity.
 *
 * Severity calibration logic:
 * 1. For each active template width, compute the severity that makes
 *    heuristic ~ markup * fair_value at the current sigma.
 * 2. Take the WEIGHTED AVERAGE severity across all active templates,
 *    weighted by 1/widthBps (narrower widths are more common/important).
 * 3. Fall back to DEFAULT_REGIME_SEVERITY if calibration fails.
 *
 * The vol indicator (sigma_7d / sigma_30d) is also logged but not stored
 * separately — it is recomputed at quote time from sigmaPpm and sigmaMaPpm.
 *
 * @param store          State store with pool, regime, and template access
 * @param params         Fresh market data (sigma, stress flag, carry rate)
 * @param signer         Signer's public key (base58) — the risk service
 * @param nowTs          Current unix timestamp. Defaults to Date.now()/1000.
 * @returns Updated RegimeSnapshot
 */
export function updateRegime(
  store: RegimeStore,
  params: RegimeParams,
  signer: string,
  nowTs?: number,
): RegimeSnapshot {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const now = nowTs ?? Math.floor(Date.now() / 1000);
  const templates = store.getAllTemplates().filter((t) => t.active);

  // Auto-calibrate severity across all active template widths
  const severityPpm = calibrateSeverityForPool(
    params.sigmaPpm,
    templates,
    pool,
    params.stressFlag,
    params.carryBpsPerDay,
  );

  // IV/RV-adaptive effective markup
  const markupFloor = pool.markupFloor ?? DEFAULT_MARKUP_FLOOR;
  const ivRvRatio = params.ivRvRatio ?? undefined;
  const effectiveMarkup = (ivRvRatio != null && ivRvRatio > 0)
    ? Math.max(markupFloor, ivRvRatio)
    : DEFAULT_MARKUP;

  const regime: RegimeSnapshot = {
    sigmaPpm: params.sigmaPpm,
    sigmaMaPpm: params.sigmaMaPpm,
    stressFlag: params.stressFlag,
    carryBpsPerDay: params.carryBpsPerDay,
    updatedTs: now,
    signer,
    severityPpm,
    ivRvRatio,
    markupFloorPpm: Math.round(markupFloor * PPM),
    effectiveMarkup,
  };

  store.setRegime(regime);
  return regime;
}

// ─── Severity Calibration for Pool ───────────────────────────────────

/**
 * Calibrate a single severity value for the entire pool by averaging
 * across all active template widths.
 *
 * The weighted average uses 1/widthBps as weights, giving more influence
 * to narrower templates which are typically more utilized.
 *
 * If calibration fails for a given width (e.g., due to zero sigma),
 * the DEFAULT_REGIME_SEVERITY fallback is used.
 *
 * @param sigmaPpm        Current 7-day sigma in PPM
 * @param templates       Active template configs
 * @param pool            Current pool state
 * @param stressFlag      Whether stress conditions apply
 * @param carryBpsPerDay  Carry cost rate
 * @param markup          Target markup (default: DEFAULT_MARKUP)
 * @returns Weighted-average severityPpm
 */
export function calibrateSeverityForPool(
  sigmaPpm: number,
  templates: TemplateConfig[],
  pool: PoolState,
  stressFlag: boolean,
  carryBpsPerDay: number,
  markup: number = DEFAULT_MARKUP,
): number {
  if (templates.length === 0) {
    // No active templates; use a sensible default
    return DEFAULT_REGIME_SEVERITY[1000] ?? 380_000;
  }

  // Reference cap for calibration (doesn't affect the ratio, only scale)
  const refCapUsdc = 100_000_000; // $100

  let weightedSum = 0;
  let totalWeight = 0;

  for (const template of templates) {
    const weight = 1 / template.widthBps;
    let severity: number;

    try {
      severity = calibrateSeverity(
        sigmaPpm,
        template.widthBps,
        refCapUsdc,
        template.tenorSeconds,
        pool,
        stressFlag,
        carryBpsPerDay,
        markup,
      );
    } catch {
      // Calibration failed (e.g., utilization overflow); use default
      severity = DEFAULT_REGIME_SEVERITY[template.widthBps] ?? 380_000;
    }

    // Sanity check: severity should be in [1, PPM]
    severity = Math.max(1, Math.min(PPM, severity));

    weightedSum += severity * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return DEFAULT_REGIME_SEVERITY[1000] ?? 380_000;
  }

  return Math.round(weightedSum / totalWeight);
}

// ─── Single-Width Calibration ────────────────────────────────────────

/**
 * Calibrate severity for a specific width. This is a convenience wrapper
 * around the pricing module's calibrateSeverity, with default fallback.
 *
 * @param sigmaPpm        Current 7-day sigma in PPM
 * @param widthBps        Position width in basis points
 * @param pool            Current pool state
 * @param stressFlag      Stress flag
 * @param carryBpsPerDay  Carry rate
 * @param tenorSeconds    Certificate tenor (default: 7 days)
 * @param markup          Target markup (default: DEFAULT_MARKUP)
 * @returns severityPpm for this specific width
 */
export function calibrateSeverityForWidth(
  sigmaPpm: number,
  widthBps: number,
  pool: PoolState,
  stressFlag: boolean,
  carryBpsPerDay: number,
  tenorSeconds: number = 7 * 86_400,
  markup: number = DEFAULT_MARKUP,
): number {
  const refCapUsdc = 100_000_000; // $100

  try {
    return calibrateSeverity(
      sigmaPpm,
      widthBps,
      refCapUsdc,
      tenorSeconds,
      pool,
      stressFlag,
      carryBpsPerDay,
      markup,
    );
  } catch {
    return DEFAULT_REGIME_SEVERITY[widthBps] ?? 380_000;
  }
}

// ─── Dual-Source IV Fetching ────────────────────────────────────────

/**
 * Fetch ATM SOL implied volatility from both Binance and Bybit,
 * return the LOWER IV to ensure competitive pricing.
 *
 * Both venues report markIV as a decimal (e.g., 0.60 = 60%).
 *
 * Binance: GET https://eapi.binance.com/eapi/v1/mark → markIV field
 * Bybit:   GET https://api.bybit.com/v5/market/tickers?category=option&baseCoin=SOL → markIv field
 *
 * The risk service calls this off-chain, then passes the result
 * as params.ivRvRatio to updateRegime().
 *
 * @param binanceIv  - ATM IV from Binance (decimal, e.g. 0.60 = 60%), or null if unavailable
 * @param bybitIv    - ATM IV from Bybit (decimal, e.g. 0.60 = 60%), or null if unavailable
 * @param realizedVol - 30d realized vol (annualized, decimal e.g. 0.58)
 * @returns { iv: number, ivRvRatio: number, source: string } or null if both fail
 */
export function computeIvRvFromDualSource(
  binanceIv: number | null,
  bybitIv: number | null,
  realizedVol: number,
): { iv: number; ivRvRatio: number; source: string } | null {
  const candidates: { iv: number; source: string }[] = [];
  if (binanceIv != null && binanceIv > 0.01) {
    candidates.push({ iv: binanceIv, source: 'Binance' });
  }
  if (bybitIv != null && bybitIv > 0.01) {
    candidates.push({ iv: bybitIv, source: 'Bybit' });
  }
  if (candidates.length === 0) return null;

  // Use the LOWER IV → lower markup → more competitive for LP
  const best = candidates.reduce((a, b) => a.iv < b.iv ? a : b);
  const ivRvRatio = best.iv / Math.max(realizedVol, 0.01);
  return { iv: best.iv, ivRvRatio, source: best.source };
}

// ─── Query Helpers ───────────────────────────────────────────────────

/**
 * Check whether the current regime is fresh (within REGIME_MAX_AGE_S).
 */
export function isRegimeFresh(regime: RegimeSnapshot | null, nowTs?: number): boolean {
  if (!regime) return false;
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  return (now - regime.updatedTs) <= 900; // REGIME_MAX_AGE_S
}

/**
 * Get the current vol indicator from a regime snapshot.
 * Convenience wrapper for use in display/logging.
 */
export function regimeVolIndicator(regime: RegimeSnapshot): number {
  return computeVolIndicator(regime.sigmaPpm, regime.sigmaMaPpm);
}

/**
 * Describe the regime in human-readable form (for CLI/logging).
 */
export function describeRegime(regime: RegimeSnapshot): string {
  const sigma7d = (regime.sigmaPpm / 10_000).toFixed(1);
  const sigma30d = (regime.sigmaMaPpm / 10_000).toFixed(1);
  const volInd = computeVolIndicator(regime.sigmaPpm, regime.sigmaMaPpm).toFixed(2);
  const severity = (regime.severityPpm / 10_000).toFixed(1);
  const age = Math.floor(Date.now() / 1000) - regime.updatedTs;

  return [
    `sigma_7d=${sigma7d}%`,
    `sigma_30d=${sigma30d}%`,
    `vol_indicator=${volInd}`,
    `severity=${severity}%`,
    `stress=${regime.stressFlag}`,
    `carry=${regime.carryBpsPerDay}bps/day`,
    `age=${age}s`,
  ].join(", ");
}
