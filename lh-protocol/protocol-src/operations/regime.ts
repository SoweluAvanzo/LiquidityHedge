/**
 * Liquidity Hedge Protocol — Regime Snapshot & Severity Calibration
 *
 * The regime snapshot captures the current market regime: volatility,
 * stress indicators, and the calibrated severity parameter for the
 * heuristic fair-value proxy.
 *
 * Key functions:
 *   resolveEffectiveMarkup: m_vol = max(markupFloor, IV/RV)
 *   calibrateSeverity:      severity so heuristic FV ≈ GH quadrature FV
 *   applySeverityFeedback:  bounded error-correction loop
 *   computeIvRvFromDualSource: pick lower IV from Binance/Bybit
 */

import {
  PPM,
  PPM_BI,
  BPS_BI,
  RegimeSnapshot,
  REGIME_MAX_AGE_S,
  DEFAULT_SEVERITY_PPM,
} from "../types";
import { StateStore } from "../state/store";
import { integerSqrt } from "../utils/math";

// ---------------------------------------------------------------------------
// Regime update
// ---------------------------------------------------------------------------

export interface UpdateRegimeParams {
  /** 30-day annualized realized volatility (PPM) */
  sigmaPpm: number;
  /** 7-day annualized realized volatility (PPM) */
  sigma7dPpm: number;
  /** Stress flag */
  stressFlag: boolean;
  /** Daily carry cost (BPS) */
  carryBpsPerDay: number;
  /** IV/RV ratio (e.g. 1.08). Use 0 if unavailable. */
  ivRvRatio: number;
}

/**
 * Update the regime snapshot with fresh market data.
 *
 * Computes effectiveMarkup = max(markupFloor, ivRvRatio) and
 * auto-calibrates severity for the heuristic proxy.
 */
export function updateRegime(
  store: StateStore,
  params: UpdateRegimeParams,
  signer: string,
  nowTs?: number,
): RegimeSnapshot {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  // Validate sigma range: 1,000 to 5,000,000 PPM (0.1% to 500%)
  const sigmaClamped = Math.max(1_000, Math.min(5_000_000, params.sigmaPpm));
  const sigma7dClamped = Math.max(
    1_000,
    Math.min(5_000_000, params.sigma7dPpm),
  );

  // Validate carry
  const carryClamped = Math.max(0, Math.min(1_000, params.carryBpsPerDay));

  // Resolve effective markup
  const effectiveMarkup = resolveEffectiveMarkup(
    params.ivRvRatio,
    pool.markupFloor,
  );

  // Calibrate severity for the default template
  const templates = store.getAllTemplates();
  let severityPpm = DEFAULT_SEVERITY_PPM;
  if (templates.length > 0) {
    severityPpm = calibrateSeverityForPool(
      sigmaClamped,
      templates[0],
      pool,
      params.stressFlag,
      carryClamped,
    );
  }

  // Apply feedback correction if previous regime exists
  const prevRegime = store.getRegime();
  if (prevRegime) {
    severityPpm = applySeverityFeedback(
      severityPpm,
      prevRegime.severityPpm,
      severityPpm,
    );
  }

  const regime: RegimeSnapshot = {
    pool: "pool",
    sigmaPpm: sigmaClamped,
    sigma7dPpm: sigma7dClamped,
    stressFlag: params.stressFlag,
    carryBpsPerDay: carryClamped,
    severityPpm,
    ivRvRatio: params.ivRvRatio,
    effectiveMarkup,
    updatedAt: nowTs ?? Math.floor(Date.now() / 1000),
    bump: 255,
  };

  store.setRegime(regime);
  return regime;
}

// ---------------------------------------------------------------------------
// Effective markup resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective volatility markup.
 *
 * m_vol = max(markupFloor, IV/RV)
 *
 * The IV/RV ratio captures the variance risk premium: when implied
 * volatility from option markets exceeds realized volatility, the
 * market prices in higher future risk. The floor prevents underpricing
 * in calm periods when IV temporarily dips below RV.
 *
 * Reference: Carr & Wu (2009), "Variance Risk Premiums"
 *
 * @param ivRvRatio   - Implied/realized vol ratio (0 if unavailable)
 * @param markupFloor - Minimum markup (e.g. 1.05)
 * @returns Effective markup >= markupFloor
 */
export function resolveEffectiveMarkup(
  ivRvRatio: number,
  markupFloor: number,
): number {
  if (ivRvRatio <= 0) return markupFloor;
  return Math.max(markupFloor, ivRvRatio);
}

// ---------------------------------------------------------------------------
// Severity calibration
// ---------------------------------------------------------------------------

/**
 * Calibrate severity so the heuristic FV approximates the true FV.
 *
 * The heuristic proxy computes:
 *   E[Payout] = Cap * p_hit * severity / PPM^2
 *
 * We want E[Payout] ≈ FV_target, where FV_target is the expected
 * payout from GBM/GH quadrature. Solving for severity:
 *
 *   severity = (FV_target - C_cap - C_adv - C_rep) * PPM^2 / (Cap * p_hit)
 *
 * Since we don't have the exact GH FV here, we use a proxy:
 *   FV_target ≈ Cap * p_hit * (width/2) / PPM (geometric approximation)
 *
 * The severity is clamped to [1, PPM] (0.0001% to 100%).
 */
export function calibrateSeverityForPool(
  sigmaPpm: number,
  template: { widthBps: number; tenorSeconds: number },
  pool: {
    reservesUsdc: number;
    activeCapUsdc: number;
    uMaxBps: number;
  },
  stressFlag: boolean,
  carryBpsPerDay: number,
): number {
  const cap = 100_000_000n; // Reference cap: $100 (scale-invariant)
  const widthPpm = BigInt(template.widthBps) * 100n;

  // Compute p_hit
  const secondsPerYear = 365n * 86_400n;
  const tenorPpm =
    (BigInt(template.tenorSeconds) * PPM_BI) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * PPM_BI);
  let pHitPpm =
    (900_000n * BigInt(sigmaPpm) * sqrtTPpm) /
    PPM_BI /
    (widthPpm > 0n ? widthPpm : 1n);
  if (pHitPpm > PPM_BI) pHitPpm = PPM_BI;
  if (pHitPpm <= 0n) return DEFAULT_SEVERITY_PPM;

  // Compute non-severity costs
  const reserves =
    pool.reservesUsdc > 0 ? BigInt(pool.reservesUsdc) : 1_000_000_000n;
  const active = BigInt(pool.activeCapUsdc);
  const uAfterPpm = ((active + cap) * PPM_BI) / reserves;
  const capitalCharge =
    (cap * uAfterPpm * uAfterPpm) / PPM_BI / PPM_BI / 5n;
  const adverse = stressFlag ? cap / 10n : 0n;
  const replication =
    (cap * BigInt(carryBpsPerDay) * BigInt(template.tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);
  const nonSeverityCosts = capitalCharge + adverse + replication;

  // Target FV: geometric proxy ≈ Cap * p_hit * (width/2) / PPM
  const fairValueProxy = (cap * pHitPpm * (widthPpm / 2n)) / PPM_BI / PPM_BI;
  const ePayoutTarget =
    Number(fairValueProxy) - Number(nonSeverityCosts);

  if (ePayoutTarget <= 0) return 1;

  // severity = ePayoutTarget * PPM^2 / (Cap * p_hit)
  const numerator = BigInt(Math.floor(ePayoutTarget)) * PPM_BI * PPM_BI;
  const denominator = cap * pHitPpm;
  if (denominator <= 0n) return DEFAULT_SEVERITY_PPM;

  const severity = Number(numerator / denominator);
  return Math.max(1, Math.min(PPM, Math.round(severity)));
}

// ---------------------------------------------------------------------------
// Severity feedback correction
// ---------------------------------------------------------------------------

/**
 * Apply bounded feedback correction to severity.
 *
 * Adjusts severity based on the gap between expected and realized loss:
 *   errorRatio = (realized - expected) / max(1, expected)
 *   rawStep = errorRatio * (feedbackGain / PPM) * severity
 *   severity += clip(rawStep, [-maxStep, +maxStep])
 *
 * The feedback loop ensures the heuristic converges toward the true FV
 * over time, without overshooting due to noisy single-week observations.
 *
 * @param currentSeverity  - Current severity (PPM)
 * @param expectedLossPpm  - Expected loss from the heuristic
 * @param realizedLossPpm  - Actual realized loss
 * @param feedbackGainPpm  - Gain factor (default 200,000 = 20%)
 * @param maxStepPpm       - Maximum adjustment per step (default 25,000 = 2.5%)
 * @returns Updated severity (PPM), clamped to [1, PPM]
 */
export function applySeverityFeedback(
  currentSeverity: number,
  expectedLossPpm: number,
  realizedLossPpm: number,
  feedbackGainPpm: number = 200_000,
  maxStepPpm: number = 25_000,
): number {
  const baseline = Math.max(1, expectedLossPpm);
  const errorRatio = (realizedLossPpm - expectedLossPpm) / baseline;
  const rawStep = Math.round(
    errorRatio * (feedbackGainPpm / PPM) * currentSeverity,
  );
  const boundedStep = Math.max(-maxStepPpm, Math.min(maxStepPpm, rawStep));
  const updated = currentSeverity + boundedStep;
  return Math.max(1, Math.min(PPM, Math.round(updated)));
}

// ---------------------------------------------------------------------------
// IV/RV from dual exchange sources
// ---------------------------------------------------------------------------

/**
 * Compute IV/RV ratio from Binance and Bybit implied volatility data.
 *
 * Takes the lower IV from the two exchanges to provide competitive
 * pricing for LPs (the protocol charges based on the cheaper option
 * market estimate of future volatility).
 *
 * @param binanceIv   - Binance ATM implied vol (annualized, e.g. 0.65), or null
 * @param bybitIv     - Bybit ATM implied vol (annualized), or null
 * @param realizedVol - 30-day trailing realized vol (annualized)
 * @returns { iv, ivRvRatio, source } or null if no IV data
 */
export function computeIvRvFromDualSource(
  binanceIv: number | null,
  bybitIv: number | null,
  realizedVol: number,
): { iv: number; ivRvRatio: number; source: string } | null {
  const candidates: { iv: number; source: string }[] = [];
  if (binanceIv != null && binanceIv > 0) {
    candidates.push({ iv: binanceIv, source: "binance" });
  }
  if (bybitIv != null && bybitIv > 0) {
    candidates.push({ iv: bybitIv, source: "bybit" });
  }

  if (candidates.length === 0) return null;

  // Pick the lower IV for LP-competitive pricing
  const best = candidates.reduce((a, b) => (a.iv < b.iv ? a : b));
  const ivRvRatio = best.iv / Math.max(realizedVol, 0.01);
  return { iv: best.iv, ivRvRatio, source: best.source };
}

// ---------------------------------------------------------------------------
// Regime freshness check
// ---------------------------------------------------------------------------

/**
 * Check if a regime snapshot is still fresh (within REGIME_MAX_AGE_S).
 */
export function isRegimeFresh(
  regime: RegimeSnapshot,
  nowTs?: number,
): boolean {
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  return now - regime.updatedAt <= REGIME_MAX_AGE_S;
}
