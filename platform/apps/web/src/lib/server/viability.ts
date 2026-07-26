/**
 * Per-position Viability Index (FR-M8), computed server-side for
 * /api/portfolio on each SOL/USDC position:
 *
 *   measuredDailyYield — Birdeye pool overview × in-range fraction ×
 *                        on-chain concentration factor (mirrors the
 *                        live-orca-test measurement pipeline). The
 *                        in-range fraction comes from the composed
 *                        estimator (empirical primary / GBM fallback,
 *                        see composeInRangeEstimate) — which method
 *                        produced it travels on the wire verbatim;
 *   fairValueUsd       — small seeded GBM Monte-Carlo of the corridor
 *                        payoff E[V(S0) − V(clamp(S_T, p_l, p_u))] at a
 *                        7-day horizon (zero drift, σ = realized vol);
 *   VI                 — computeViability() from @lh/portfolio.
 *
 * Failure policy: any missing input (no BIRDEYE_API_KEY, pool-overview
 * fetch failure, insufficient candles for realized vol) yields null —
 * the card shows "viability unavailable"; a value is never faked.
 */

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import type {
  EmpiricalInRangeInput,
  InRangeEstimate,
  PortfolioPositionView,
} from "@lh/portfolio";
import {
  composeInRangeEstimate,
  computeViability,
  positionValueAtPrice,
} from "@lh/portfolio";
import { computeRealizedVol, empiricalInRangeFraction } from "@lh/market-data";
import { GbmModel } from "@lh/risk-models";
import type { WhirlpoolData } from "@lh/core/src/market-data/decoder";
import {
  computeConcentrationFactor,
  estimatePoolDailyYield,
  estimatePositionDailyYield,
  type PoolOverview,
} from "@lh/core/src/market-data/orca-volume-adapter";
import { getPoolOverview, getSolDailyCandles, birdeyeApiKey } from "./birdeye";
import type { PositionViabilityWire } from "@/lib/portfolio-api";

const TENOR_DAYS = 7;
const TENOR_SECONDS = TENOR_DAYS * 86_400;
const EFFECTIVE_MARKUP = 1.08;
const PREMIUM_FLOOR_USD =
  Number(process.env.HEDGE_PREMIUM_FLOOR_USDC ?? 50_000) / 1e6;
const FEE_SPLIT_RATE = 0.1;

const FV_PATHS = 20_000;
const FV_SEED = 1;

/** Concentration-factor sanity window (same policy as live-orca-test). */
const C_SANITY_MIN = 0.5;
const C_SANITY_MAX = 50;

const CANDLE_WINDOW_DAYS = 90;

/** Empirical in-range estimator: rolling windows over one year of closes. */
const EMPIRICAL_WINDOW_DAYS = 365;

/**
 * In-range prediction log (groundwork for predictive scoring — future
 * arbitration of estimators by realized outcomes). Same `.data` dir as
 * the hedge event ledger; gitignored (`/.data/` in this app's .gitignore
 * and `.data/` in platform/.gitignore), never committed.
 */
const DATA_DIR = path.join(process.cwd(), ".data");
const PREDICTIONS_PATH = path.join(DATA_DIR, "inrange-predictions.jsonl");

interface InRangePredictionRecord {
  ts: string;
  whirlpool: string;
  priceLower: number;
  priceUpper: number;
  widthBps: number;
  horizonDays: number;
  gbmFraction: number;
  gbmSigma: number;
  empiricalMean: number | null;
  empiricalWindows: number | null;
  methodUsed: InRangeEstimate["method"];
}

/** Append-one-line prediction log; a disk failure must never take down
 *  the viability computation itself. */
function appendPredictionLog(record: InRangePredictionRecord): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(PREDICTIONS_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(
      "[viability] prediction log append failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Short human-readable cause for the UI's "empirical unavailable" note. */
function empiricalFailureReason(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/HTTP 401|HTTP 403|HTTP 429/.test(msg)) {
    return "market-data provider rejected the request (key suspended?)";
  }
  return msg.length > 140 ? `${msg.slice(0, 137)}...` : msg;
}

/**
 * Empirical in-range input for composeInRangeEstimate: one year of daily
 * closes, rolling 7-day windows. On ANY failure (e.g. a suspended
 * market-data key, history too short) returns null plus a
 * human-readable reason — the composition then falls back to the GBM
 * analytic and labels itself accordingly; values are never faked.
 */
async function loadEmpiricalInRange(
  widthBps: number,
  horizonSteps: number,
): Promise<{ empirical: EmpiricalInRangeInput | null; reason: string | null }> {
  try {
    const { candles } = await getSolDailyCandles(EMPIRICAL_WINDOW_DAYS);
    const closes = candles.map((c) => c.c);
    return {
      empirical: empiricalInRangeFraction(closes, widthBps, horizonSteps),
      reason: null,
    };
  } catch (error) {
    const reason = empiricalFailureReason(error);
    console.error(`[viability] empirical in-range unavailable: ${reason}`);
    return { empirical: null, reason };
  }
}

interface SigmaEstimate {
  sigma: number;
  windowDays: 30 | 90;
  closes: number[];
}

/**
 * Shared measurement basis for a position's fee yield: Birdeye pool
 * overview + on-chain concentration factor (same sanity window + c=1
 * fallback as the live measurement script). Used by BOTH the viability
 * computation below and the simulate route's in-range rate — one code
 * path, never two divergent measurements.
 */
async function poolYieldBasis(
  view: PortfolioPositionView,
  whirlpool: WhirlpoolData,
): Promise<{ overview: PoolOverview; concentrationFactor: number }> {
  // Whirlpool fee_rate is parts-per-million (SOL/USDC 0.04% pool = 400).
  const feeTier = whirlpool.feeRate / 1_000_000;
  const overview = await getPoolOverview(view.whirlpool, feeTier);

  // Concentration factor from on-chain L-share vs USD V-share, with the
  // same sanity window + c=1 fallback as the live measurement script.
  const cRaw = computeConcentrationFactor({
    L_position: view.liquidity,
    L_active: whirlpool.liquidity,
    V_position_usd: view.valueQuote,
    TVL_usd: overview.liquidityUsd,
  });
  const concentrationFactor =
    cRaw !== null && cRaw >= C_SANITY_MIN && cRaw <= C_SANITY_MAX ? cRaw : 1;
  return { overview, concentrationFactor };
}

/**
 * IN-RANGE-CONDITIONAL daily fee rate on position value, for the
 * Monte-Carlo engine's yield accrual:
 *
 *   inRangeDailyRate = poolDailyYield × concentrationFactor
 *
 * i.e. measuredDailyYield ÷ inRangeFraction — the same pool-overview and
 * concentration intermediates behind /api/portfolio's viability, with the
 * in-range fraction deliberately EXCLUDED: the engine applies the in-range
 * indicator along each simulated path itself, so pre-multiplying by an
 * expected occupancy would double-count range exits.
 *
 * Returns null (never a guess) when market data is unavailable.
 */
export async function computeInRangeDailyRate(
  view: PortfolioPositionView,
  whirlpool: WhirlpoolData,
): Promise<number | null> {
  const basis = await computePoolYieldBasis(view, whirlpool);
  if (!basis) return null;
  return estimatePoolDailyYield(basis.overview) * basis.concentrationFactor;
}

/**
 * Failure-safe exported wrapper around the shared yield basis, for callers
 * that need the overview and concentration factor SEPARATELY (e.g. the
 * simulate route's stochastic fee intensity, which scales sampled r_pool
 * paths by `c`). Returns null (never a guess) when market data is
 * unavailable.
 */
export async function computePoolYieldBasis(
  view: PortfolioPositionView,
  whirlpool: WhirlpoolData,
): Promise<{ overview: PoolOverview; concentrationFactor: number } | null> {
  if (!birdeyeApiKey()) return null;
  try {
    if (view.valueQuote <= 0) return null;
    return await poolYieldBasis(view, whirlpool);
  } catch (error) {
    console.error(
      `[viability] yield basis unavailable for ${view.positionAddress}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Realized vol from ingested daily candles: 30d window preferred, 90d
 * fallback; null when even 90d cannot support a vol estimate.
 */
async function solSigmaEstimate(): Promise<SigmaEstimate | null> {
  const { candles } = await getSolDailyCandles(CANDLE_WINDOW_DAYS);
  const closes = candles.map((c) => c.c);
  const last31 = candles.slice(-31); // 30 daily returns
  const rv30 = computeRealizedVol(last31, "1D");
  if (rv30) return { sigma: rv30.sigma, windowDays: 30, closes };
  const rv90 = computeRealizedVol(candles, "1D");
  if (rv90) return { sigma: rv90.sigma, windowDays: 90, closes };
  return null;
}

/**
 * Fair value of the 7-day corridor hedge payoff via seeded GBM MC:
 * FV = mean over paths of [V(S0) − V(clamp(S_T, p_l, p_u))] (plain,
 * signed mean — the payoff is bilateral by design).
 */
function fairValueMc(
  view: PortfolioPositionView,
  sigma: number,
  closes: number[],
): number {
  const model = new GbmModel();
  const params = model.calibrate(
    [{ assetId: "SOL", closes, stepSeconds: 86_400 }],
    { driftMode: "zero", sigmaOverride: [sigma] },
  );
  params.s0 = [view.price]; // rebase to the live pool price
  const paths = model.simulatePaths(params, {
    horizonSteps: 1,
    stepSeconds: TENOR_SECONDS,
    nPaths: FV_PATHS,
    seed: FV_SEED,
  });

  const v0 = positionValueAtPrice(view, view.price);
  let sum = 0;
  const solPaths = paths.prices[0];
  for (let p = 0; p < FV_PATHS; p++) {
    const sT = solPaths[p][1];
    const clamped = Math.min(Math.max(sT, view.priceLower), view.priceUpper);
    sum += v0 - positionValueAtPrice(view, clamped);
  }
  return sum / FV_PATHS;
}

/**
 * Viability for one SOL/USDC position. Returns null (never a guess) when
 * any input is unavailable; the reason is logged server-side only.
 */
export async function computePositionViability(
  view: PortfolioPositionView,
  whirlpool: WhirlpoolData,
  sigmaEstimate: SigmaEstimate,
): Promise<PositionViabilityWire | null> {
  try {
    if (view.valueQuote <= 0) return null;

    const { overview, concentrationFactor: c } = await poolYieldBasis(
      view,
      whirlpool,
    );

    // Symmetric-width equivalent of the position's range around the
    // current price (the adapter's in-range model is symmetric in w).
    const widthBps = Math.max(
      1,
      ((view.priceUpper - view.priceLower) / 2 / view.price) * 10_000,
    );

    const { sigma, windowDays, closes } = sigmaEstimate;
    const est = estimatePositionDailyYield(
      overview,
      widthBps,
      sigma,
      TENOR_SECONDS,
      c,
    );

    // Empirical estimator width: symmetric half-width of the position's
    // range as a fraction of the range MIDPOINT — (pU − pL)/(pU + pL) =
    // halfWidth/midpoint. This is the symmetric-equivalent of the actual
    // [pL, pU] range, the same ±w symmetric-band convention the GBM path
    // assumes (inRangeProbabilityAt models [S·(1−w), S·(1+w)]), so both
    // estimators answer the same question about the same range shape.
    const empiricalWidthBps = Math.round(
      ((view.priceUpper - view.priceLower) /
        (view.priceUpper + view.priceLower)) *
        10_000,
    );

    // Estimator policy (2026-07-08): empirical is PRIMARY when history
    // allows, GBM analytic is the pricing-consistent reference,
    // disagreement is surfaced (never averaged), and the method used is
    // labeled on the wire for verbatim display in the UI.
    const { empirical, reason } = await loadEmpiricalInRange(
      empiricalWidthBps,
      TENOR_DAYS, // 7 daily steps — the 7-day tenor
    );
    const inRangeEstimate = composeInRangeEstimate({
      empirical,
      gbm: { fraction: est.inRangeFraction, sigmaAnnual: sigma },
      ...(reason ? { empiricalUnavailableReason: reason } : {}),
    });

    // Measured yield uses the PRIMARY estimator's fraction (identical to
    // the previous GBM-only value whenever the fallback is in effect).
    const measuredDailyYield =
      est.poolDailyYield * inRangeEstimate.fraction * c;

    const fairValueUsd = fairValueMc(view, sigma, closes);

    const result = computeViability({
      fairValueUsd,
      effectiveMarkup: EFFECTIVE_MARKUP,
      premiumFloorUsd: PREMIUM_FLOOR_USD,
      feeSplitRate: FEE_SPLIT_RATE,
      positionValueUsd: view.valueQuote,
      tenorDays: TENOR_DAYS,
      measuredDailyYield,
    });

    appendPredictionLog({
      ts: new Date().toISOString(),
      whirlpool: view.whirlpool,
      priceLower: view.priceLower,
      priceUpper: view.priceUpper,
      widthBps: empiricalWidthBps,
      horizonDays: TENOR_DAYS,
      gbmFraction: est.inRangeFraction,
      gbmSigma: sigma,
      empiricalMean: empirical ? empirical.mean : null,
      empiricalWindows: empirical ? empirical.windows : null,
      methodUsed: inRangeEstimate.method,
    });

    return {
      // Infinity (zero breakeven) does not survive JSON — null encodes it.
      viabilityIndex: Number.isFinite(result.viabilityIndex)
        ? result.viabilityIndex
        : null,
      breakevenDailyYield: result.breakevenDailyYield,
      measuredDailyYield,
      bound: result.bound,
      fairValueUsd,
      sigmaAnnualized: sigma,
      sigmaWindowDays: windowDays,
      poolDailyYield: est.poolDailyYield,
      inRangeFraction: inRangeEstimate.fraction,
      concentrationFactor: c,
      tenorDays: TENOR_DAYS,
      inRangeEstimate,
      empiricalWindows: empirical ? empirical.windows : null,
    };
  } catch (error) {
    console.error(
      `[viability] unavailable for ${view.positionAddress}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Shared inputs for a batch of positions: null when Birdeye is not
 * configured or the candle/vol pipeline cannot deliver — every position
 * then reports "viability unavailable".
 */
export async function loadViabilityInputs(): Promise<SigmaEstimate | null> {
  if (!birdeyeApiKey()) return null;
  try {
    return await solSigmaEstimate();
  } catch (error) {
    console.error(
      "[viability] sigma estimate unavailable:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
