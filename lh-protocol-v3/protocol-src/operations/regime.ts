/**
 * Regime management: update market regime snapshot with dynamic severity.
 *
 * v3 simplifications from v2:
 * - No vol indicator (sigma_7d / sigma_30d) -- removed with two-part premium
 * - IV/RV sourced from dual exchange (Bybit + Binance, pick lower)
 * - effectiveMarkup = max(floor, ivRvRatio) computed here and stored
 * - Severity derived from effectiveMarkup: the calibration targets fair value
 *   (markup = 1.0), then the effectiveMarkup is applied multiplicatively in pricing
 * - Simpler severity fallback: single default, not per-width
 *
 * The regime update is called by the off-chain risk service every 15 minutes
 * (REGIME_MAX_AGE_S = 900s) using Birdeye OHLCV data for realized vol
 * and Bybit/Binance option data for implied vol.
 */

import {
  RegimeSnapshot,
  RegimeParams,
  PoolState,
  TemplateConfig,
  PPM,
  DEFAULT_MARKUP_FLOOR,
} from "../types";
import { calibrateSeverity, resolveEffectiveMarkup } from "./pricing";

// ─── Constants ──────────────────────────────────────────────────────

/** Default severity when calibration fails or no templates are active. */
const DEFAULT_SEVERITY_PPM = 380_000;

// ─── State Store Interface ───────────────────────────────────────────

export interface RegimeStore {
  getPool(): PoolState | null;
  getRegime(): RegimeSnapshot | null;
  setRegime(regime: RegimeSnapshot): void;
  getAllTemplates(): TemplateConfig[];
}

// ─── Regime Update ───────────────────────────────────────────────────

/**
 * Update the regime snapshot with fresh market data.
 *
 * Steps:
 *   1. Accept sigma, stressFlag, carryBps, ivRvRatio from risk service
 *   2. Compute effectiveMarkup = max(pool.markupFloor, ivRvRatio)
 *   3. Auto-calibrate severity across active templates
 *   4. Store updated regime
 *
 * @param store    State store with pool, regime, and template access
 * @param params   Fresh market data
 * @param signer   Signer's public key (risk service)
 * @param nowTs    Current unix timestamp
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

  // Effective markup from IV/RV
  const markupFloor = pool.markupFloor ?? DEFAULT_MARKUP_FLOOR;
  const ivRvRatio = params.ivRvRatio ?? markupFloor;
  const effectiveMarkup = resolveEffectiveMarkup(ivRvRatio, markupFloor);

  // Auto-calibrate severity across all active template widths
  const baseSeverityPpm = calibrateSeverityForPool(
    params.sigmaPpm,
    templates,
    pool,
    params.stressFlag,
    params.carryBpsPerDay,
  );
  const severityPpm = applySeverityFeedback(
    baseSeverityPpm,
    params.expectedLossPpm,
    params.realizedLossPpm,
    params.feedbackGainPpm,
    params.maxSeverityStepPpm,
  );

  const regime: RegimeSnapshot = {
    sigmaPpm: params.sigmaPpm,
    sigmaMaPpm: params.sigmaMaPpm,
    stressFlag: params.stressFlag,
    carryBpsPerDay: params.carryBpsPerDay,
    updatedTs: now,
    signer,
    severityPpm,
    ivRvRatio,
    effectiveMarkup,
  };

  store.setRegime(regime);
  return regime;
}

/**
 * Apply bounded forecast-error feedback to severity.
 * Positive error (realized > expected loss) increases severity;
 * negative error reduces severity. Update is capped per regime tick.
 */
export function applySeverityFeedback(
  severityPpm: number,
  expectedLossPpm?: number,
  realizedLossPpm?: number,
  feedbackGainPpm: number = 200_000,
  maxStepPpm: number = 25_000,
): number {
  if (
    expectedLossPpm == null ||
    realizedLossPpm == null ||
    expectedLossPpm < 0 ||
    realizedLossPpm < 0
  ) {
    return Math.max(1, Math.min(PPM, Math.round(severityPpm)));
  }

  const baseline = Math.max(1, expectedLossPpm);
  const errorRatio = (realizedLossPpm - expectedLossPpm) / baseline;
  const rawStep = Math.round(errorRatio * (feedbackGainPpm / PPM) * severityPpm);
  const boundedStep = Math.max(-maxStepPpm, Math.min(maxStepPpm, rawStep));
  const updated = severityPpm + boundedStep;
  return Math.max(1, Math.min(PPM, Math.round(updated)));
}

// ─── Severity Calibration for Pool ───────────────────────────────────

/**
 * Calibrate a single severity value for the entire pool by averaging
 * across all active template widths.
 *
 * Uses 1/widthBps weighting: narrower templates get more influence.
 * Falls back to DEFAULT_SEVERITY_PPM if calibration fails.
 *
 * In v3, severity targets fair value (markup = 1.0). The effectiveMarkup
 * is applied multiplicatively in the pricing formula, so severity does
 * not need to account for the markup itself.
 *
 * @param sigmaPpm        Current 7-day sigma in PPM
 * @param templates       Active template configs
 * @param pool            Current pool state
 * @param stressFlag      Whether stress conditions apply
 * @param carryBpsPerDay  Carry cost rate
 * @returns Weighted-average severityPpm
 */
export function calibrateSeverityForPool(
  sigmaPpm: number,
  templates: TemplateConfig[],
  pool: PoolState,
  stressFlag: boolean,
  carryBpsPerDay: number,
): number {
  if (templates.length === 0) {
    return DEFAULT_SEVERITY_PPM;
  }

  // Reference cap for calibration (scale-invariant: ratio matters, not absolute)
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
      );
    } catch {
      severity = DEFAULT_SEVERITY_PPM;
    }

    severity = Math.max(1, Math.min(PPM, severity));

    weightedSum += severity * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return DEFAULT_SEVERITY_PPM;
  }

  return Math.round(weightedSum / totalWeight);
}

// ─── Single-Width Calibration ────────────────────────────────────────

/**
 * Calibrate severity for a specific width. Convenience wrapper
 * around the pricing module's calibrateSeverity with fallback.
 *
 * @param sigmaPpm        Current 7-day sigma in PPM
 * @param widthBps        Position width in basis points
 * @param pool            Current pool state
 * @param stressFlag      Stress flag
 * @param carryBpsPerDay  Carry rate
 * @param tenorSeconds    Certificate tenor (default: 7 days)
 * @returns severityPpm for this specific width
 */
export function calibrateSeverityForWidth(
  sigmaPpm: number,
  widthBps: number,
  pool: PoolState,
  stressFlag: boolean,
  carryBpsPerDay: number,
  tenorSeconds: number = 7 * 86_400,
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
    );
  } catch {
    return DEFAULT_SEVERITY_PPM;
  }
}

// ─── Dual-Source IV Fetching ────────────────────────────────────────

/**
 * Compute the IV/RV ratio from dual exchange sources.
 *
 * Takes ATM SOL implied volatility from both Binance and Bybit,
 * picks the LOWER IV (more conservative for LP, competitive pricing),
 * then divides by realized vol to get the ratio.
 *
 * Binance: GET https://eapi.binance.com/eapi/v1/mark -> markIV field
 * Bybit:   GET https://api.bybit.com/v5/market/tickers?category=option&baseCoin=SOL -> markIv field
 *
 * The risk service calls this off-chain, then passes the result
 * as params.ivRvRatio to updateRegime().
 *
 * @param binanceIv   ATM IV from Binance (decimal, e.g. 0.60 = 60%), or null
 * @param bybitIv     ATM IV from Bybit (decimal, e.g. 0.60 = 60%), or null
 * @param realizedVol 30d realized vol (annualized, decimal e.g. 0.58)
 * @returns { iv, ivRvRatio, source } or null if both sources fail
 */
export function computeIvRvFromDualSource(
  binanceIv: number | null,
  bybitIv: number | null,
  realizedVol: number,
): { iv: number; ivRvRatio: number; source: string } | null {
  const candidates: { iv: number; source: string }[] = [];
  if (binanceIv != null && binanceIv > 0.01) {
    candidates.push({ iv: binanceIv, source: "Binance" });
  }
  if (bybitIv != null && bybitIv > 0.01) {
    candidates.push({ iv: bybitIv, source: "Bybit" });
  }
  if (candidates.length === 0) return null;

  // Use the LOWER IV -> lower markup -> more competitive for LP
  const best = candidates.reduce((a, b) => (a.iv < b.iv ? a : b));
  const ivRvRatio = best.iv / Math.max(realizedVol, 0.01);
  return { iv: best.iv, ivRvRatio, source: best.source };
}

// ─── Query Helpers ───────────────────────────────────────────────────

/**
 * Check whether the current regime is fresh (within REGIME_MAX_AGE_S).
 */
export function isRegimeFresh(
  regime: RegimeSnapshot | null,
  nowTs?: number,
): boolean {
  if (!regime) return false;
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  return now - regime.updatedTs <= 900;
}

/**
 * Describe the regime in human-readable form (for CLI/logging).
 */
export function describeRegime(regime: RegimeSnapshot): string {
  const sigma7d = (regime.sigmaPpm / 10_000).toFixed(1);
  const sigma30d = (regime.sigmaMaPpm / 10_000).toFixed(1);
  const severity = (regime.severityPpm / 10_000).toFixed(1);
  const markup = regime.effectiveMarkup.toFixed(2);
  const ivRv = regime.ivRvRatio.toFixed(2);
  const age = Math.floor(Date.now() / 1000) - regime.updatedTs;

  return [
    `sigma_7d=${sigma7d}%`,
    `sigma_30d=${sigma30d}%`,
    `IV/RV=${ivRv}`,
    `effectiveMarkup=${markup}`,
    `severity=${severity}%`,
    `stress=${regime.stressFlag}`,
    `carry=${regime.carryBpsPerDay}bps/day`,
    `age=${age}s`,
  ].join(", ");
}
