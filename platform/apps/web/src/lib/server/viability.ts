/**
 * Per-position Viability Index (FR-M8), computed server-side for
 * /api/portfolio on each SOL/USDC position:
 *
 *   measuredDailyYield — realised in-range fee intensity (the
 *                        position's own feeGrowthInside, §1.2) × the
 *                        FORWARD in-range fraction when history allows;
 *                        otherwise pool yield (measured from our own
 *                        feeGrowthGlobal snapshots §1.1, Birdeye as
 *                        labelled fallback) × fraction × concentration
 *                        factor; provenance travels on the wire. The
 *                        in-range fraction comes from the composed
 *                        estimator (empirical primary / GBM fallback,
 *                        see composeInRangeEstimate) — which method
 *                        produced it travels on the wire verbatim;
 *   fairValueUsd       — deterministic Simpson quadrature (§1.3, the
 *                        paper's §3.2 method) of the corridor payoff
 *                        E[V(S0) − V(clamp(S_T, p_l, p_u))] at a 7-day
 *                        horizon (risk-neutral GBM, σ = realized vol);
 *   VI                 — computeViability() from @lh/portfolio.
 *
 * Failure policy: each source degrades independently and LABELLED
 * (measured→modelled fallbacks with reasons); only when no source can
 * serve an input (e.g. no candles for σ) does the record become null —
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
  computeTwoSidedViability,
  positionValueAtPrice,
} from "@lh/portfolio";
import {
  computeGarmanKlassVol,
  computeNonOverlappingTenorVol,
  computeRealizedVol,
  empiricalInRangeFractionBounds,
  varianceRatio,
  type RealizedVol,
} from "@lh/market-data";
import { quadratureExpectation } from "@lh/core/src/pricing-engine/pricing";
import { SECONDS_PER_YEAR } from "@lh/core/src/types";
import type { WhirlpoolData } from "@lh/core/src/market-data/decoder";
import {
  computeConcentrationFactor,
  estimatePoolDailyYield,
  inRangeFractionBoundsDiscrete,
  lpFeeTier,
  type PoolOverview,
} from "@lh/core/src/market-data/orca-volume-adapter";
import { getPoolOverview, getSolDailyCandles, birdeyeApiKey } from "./birdeye";
import { readMeasuredPoolYield } from "./pool-yield";
import { readRealisedPositionYield } from "./position-yield";
import {
  getStaticPricingParams,
  getEffectiveMarkup,
  type EffectiveMarkupResult,
} from "./pricing-params";
import type { PositionViabilityWire } from "@/lib/portfolio-api";

// §1.8: premium parameters come from the ONE module the quote path
// also reads — the dashboard previously hardcoded EFFECTIVE_MARKUP =
// 1.08 and its own fee split, pricing a certificate nobody would be
// quoted (A7/D-5). The live markup (max(floor, IV/RV)) is fetched per
// batch in loadViabilityInputs.
const PRICING = getStaticPricingParams();
const TENOR_SECONDS = PRICING.tenorSeconds;
const TENOR_DAYS = TENOR_SECONDS / 86_400;
const PREMIUM_FLOOR_USD = PRICING.premiumFloorUsdc / 1e6;
/** Protocol treasury fee φ — the only leakage in the paper's §2.4.2
 * redistribution identity, and the whole of the docs/02 wedge corollary
 * φP/(V·T) (the second 'Corollary 2.1' there — see the Lemma renumber). */
const PROTOCOL_FEE_RATE = PRICING.protocolFeeBps / 10_000;
const FEE_SPLIT_RATE = PRICING.feeSplitRate;

/** Concentration-factor sanity window (same policy as live-orca-test). */
const C_SANITY_MIN = 0.5;
const C_SANITY_MAX = 50;

/** §1.6: annualized physical-drift sweep for the E[ΔV] sensitivity
 *  display (±50%/yr, the plan's own table). Display only — nothing
 *  prices off a directional view. */
const DRIFT_SWEEP_ANNUAL = 0.5;

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

/**
 * §1.10 (closes F12): v1 records paired a `widthBps` computed on the
 * EMPIRICAL midpoint convention with a `gbmFraction` computed on ACTUAL
 * bounds — a mismatched pair that made the log useless for the
 * estimator arbitration it exists for. v2 records the actual bounds and
 * spot (sufficient to re-derive any width convention), BOTH estimators'
 * fractions like-for-like on those bounds, the empirical mean CI, and
 * which fraction was served — everything needed to score both
 * estimators against the realized outcome once the horizon elapses.
 */
interface InRangePredictionRecord {
  v: 2;
  ts: string;
  whirlpool: string;
  position: string;
  priceLower: number;
  priceUpper: number;
  spot: number;
  horizonDays: number;
  gbmFraction: number;
  gbmSigma: number;
  empiricalMean: number | null;
  empiricalMeanCi: { p05: number; p95: number } | null;
  empiricalWindows: number | null;
  empiricalNEffective: number | null;
  methodUsed: InRangeEstimate["method"];
  /** The fraction actually served into measuredDailyYield. */
  fractionUsed: number;
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

/** Short human-readable cause for the UI's "empirical unavailable"
 *  note. F13: raw internal exception text (e.g. "widthBps 0 out of
 *  (0, 10000)") must never reach the browser — known failure classes
 *  map to plain language, everything else to a generic line with the
 *  raw text kept in server logs. */
function empiricalFailureReason(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/HTTP 401|HTTP 403|HTTP 429/.test(msg)) {
    return "market-data provider rejected the request (key suspended?)";
  }
  if (/history too short/.test(msg)) {
    return "price history too short for the horizon";
  }
  if (/widthBps|invalid range|horizonSteps/.test(msg)) {
    return "range parameters outside the estimator's domain";
  }
  console.error("[viability] empirical estimator failure (raw):", msg);
  return "estimator unavailable (details in server logs)";
}

/**
 * Empirical in-range input for composeInRangeEstimate: one year of daily
 * closes, rolling 7-day windows. On ANY failure (e.g. a suspended
 * market-data key, history too short) returns null plus a
 * human-readable reason — the composition then falls back to the GBM
 * analytic and labels itself accordingly; values are never faked.
 */
async function loadEmpiricalInRange(
  priceLower: number,
  priceUpper: number,
  spot: number,
  horizonSteps: number,
): Promise<{ empirical: EmpiricalInRangeInput | null; reason: string | null }> {
  try {
    const { candles } = await getSolDailyCandles(EMPIRICAL_WINDOW_DAYS);
    const closes = candles.map((c) => c.c);
    return {
      // Actual bounds, not a width re-centred on spot — the empirical
      // estimator is PRIMARY once ~60 windows exist, so fixing only the
      // GBM reference leg would have left the served number unchanged.
      empirical: empiricalInRangeFractionBounds(
        closes,
        priceLower,
        priceUpper,
        spot,
        horizonSteps,
      ),
      reason: null,
    };
  } catch (error) {
    const reason = empiricalFailureReason(error);
    console.error(`[viability] empirical in-range unavailable: ${reason}`);
    return { empirical: null, reason };
  }
}

export interface SigmaEstimate {
  /** The σ actually served and priced with: daily estimator × tenor
   *  adjustment (when available). */
  sigma: number;
  /** 90% interval for σ itself (p05/p95), scaled by the same tenor
   *  adjustment; block bootstrap on Garman–Klass, analytic 1/√(2n) on
   *  the close-to-close fallback. */
  band: { p05: number; p95: number };
  windowDays: 30 | 90;
  method: "garman-klass" | "close-to-close";
  nDays: number;
  /** Unadjusted daily-annualised estimate, for transparency. */
  sigmaDaily: number;
  /**
   * Owner decision D5 (2026-07-27): the corridor payoff depends on
   * TENOR-scale dispersion, and SOL mean-reverts at the weekly scale
   * (VR(7) ≈ 0.76 over 1y) — daily-annualised estimators overstate it.
   * The adjustment is σ_weekly-nonoverlap(1y) ÷ σ_same-method-daily(1y):
   * the 30d estimator keeps tracking the current regime, the 1y ratio
   * corrects the scale mismatch. Null when 1y history is unavailable —
   * then the UNADJUSTED daily estimate serves, labelled.
   */
  tenorAdjust: {
    ratio: number;
    weeklySigma1y: number;
    weeklyN: number;
    dailySigma1y: number;
    varianceRatio7: number;
  } | null;
}

/** §1.1 provenance-carrying yield basis — see poolYieldBasis below. */
export interface PoolYieldBasis {
  /** The pool daily yield actually used downstream. */
  poolDailyYield: number;
  /** §1.7: 90% CI on the measured yield; null on the Birdeye fallback
   *  (the vendor number carries no quantified uncertainty — the band
   *  then simply omits this source and says so). */
  poolDailyYieldCi: { p05: number; p95: number } | null;
  source: "measured-snapshots" | "modelled-birdeye";
  /** Measured-window metadata (null on the modelled path). */
  window: {
    coveredSeconds: number;
    windowSeconds: number;
    intervals: number;
    firstT: number;
    lastT: number;
  } | null;
  /** Why the modelled fallback was used (null on the measured path). */
  fallbackReason: string | null;
  /** TVL used for the concentration factor, and where it came from. */
  tvlQuote: number;
  tvlSource: "onchain-vaults" | "birdeye";
  concentrationFactor: number;
  /** Birdeye overview when reachable — still needed by the simulate
   *  route's stochastic fee-intensity SHAPE (pair volume history); null
   *  when Birdeye is down and the measured path carries the basis. */
  overview: PoolOverview | null;
}

/**
 * Shared measurement basis for a position's fee yield, used by BOTH the
 * viability computation below and the simulate route's in-range rate —
 * one code path, never two divergent measurements.
 *
 * §1.1: the PRIMARY source is direct measurement from our own 15-minute
 * `feeGrowthGlobal` snapshots — the accumulator the Whirlpool program
 * itself pays LPs from. It is vendor-free and net of the protocol fee by
 * construction. The Birdeye volume×feeTier/TVL model is retained ONLY as
 * a labelled fallback for pools whose snapshot coverage is too short.
 */
async function poolYieldBasis(
  view: PortfolioPositionView,
  whirlpool: WhirlpoolData,
): Promise<PoolYieldBasis | null> {
  const measured = await readMeasuredPoolYield(
    view.whirlpool,
    view.decimalsA,
    view.decimalsB,
    view.tokenMintB,
  );

  // The Birdeye overview is fetched even when the measured path succeeds:
  // the simulate route needs its pair-volume SHAPE, and the concentration
  // factor needs a TVL fallback when the newest snapshot is stale.
  let overview: PoolOverview | null = null;
  if (birdeyeApiKey()) {
    try {
      // NET of Orca's protocol share — LPs do not accrue the whole swap
      // fee. Using the gross rate overstated every yield by ~14.9%.
      const feeTier = lpFeeTier(whirlpool.feeRate, whirlpool.protocolFeeRate);
      overview = await getPoolOverview(view.whirlpool, feeTier);
    } catch (error) {
      console.error(
        `[viability] pool overview unavailable for ${view.whirlpool}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // TVL for the concentration factor: exact on-chain vaults when the
  // newest snapshot is fresh, Birdeye otherwise. c is a current-state
  // quantity, so it takes the freshest TVL regardless of yield source.
  let tvlQuote: number;
  let tvlSource: PoolYieldBasis["tvlSource"];
  if (measured.ok && measured.latestTvlQuote !== null && measured.latestTvlQuote > 0) {
    tvlQuote = measured.latestTvlQuote;
    tvlSource = "onchain-vaults";
  } else if (overview) {
    tvlQuote = overview.liquidityUsd;
    tvlSource = "birdeye";
  } else {
    return null; // no TVL from either source — c cannot be computed
  }

  // Concentration factor from on-chain L-share vs USD V-share. An
  // out-of-band value is reported UNAVAILABLE, never replaced with 1.
  const cRaw = computeConcentrationFactor({
    L_position: view.liquidity,
    L_active: whirlpool.liquidity,
    V_position_usd: view.valueQuote,
    TVL_usd: tvlQuote,
  });
  // Substituting 1 here silently discarded the real value for the two
  // commonest shapes — full-range (c well below the floor) and very tight
  // (c well above the ceiling) — and then printed "concentration factor
  // 1.00" as if measured, flipping the viability verdict in BOTH
  // directions. This file's own policy is that a value is never faked, so
  // an out-of-band c makes the whole record unavailable.
  if (cRaw === null || cRaw < C_SANITY_MIN || cRaw > C_SANITY_MAX) {
    console.warn(
      `[viability] concentration factor ${cRaw} outside [${C_SANITY_MIN}, ` +
        `${C_SANITY_MAX}] for ${view.positionAddress} — reporting unavailable ` +
        `rather than substituting 1`,
    );
    return null;
  }

  if (measured.ok) {
    return {
      poolDailyYield: measured.measured.dailyYield,
      poolDailyYieldCi: measured.measured.dailyYieldCi,
      source: "measured-snapshots",
      window: {
        coveredSeconds: measured.measured.coveredSeconds,
        windowSeconds: measured.measured.windowSeconds,
        intervals: measured.measured.intervals,
        firstT: measured.measured.firstT,
        lastT: measured.measured.lastT,
      },
      fallbackReason: null,
      tvlQuote,
      tvlSource,
      concentrationFactor: cRaw,
      overview,
    };
  }
  if (overview) {
    console.warn(
      `[viability] measured pool yield unavailable for ${view.whirlpool} ` +
        `(${measured.reason}) — falling back to the Birdeye model, labelled`,
    );
    return {
      poolDailyYield: estimatePoolDailyYield(overview),
      poolDailyYieldCi: null,
      source: "modelled-birdeye",
      window: null,
      fallbackReason: measured.reason,
      tvlQuote,
      tvlSource,
      concentrationFactor: cRaw,
      overview,
    };
  }
  return null; // neither measured nor modelled available
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
  return basis.poolDailyYield * basis.concentrationFactor;
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
): Promise<PoolYieldBasis | null> {
  // No Birdeye gate here any more: the measured-snapshot path works
  // without a vendor key; each source degrades independently.
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

/** Minimum candle coverage before σ is computed at all — degraded
 *  ingestion must refuse loudly, not feed pricing (§E7). */
const SIGMA_MIN_COVERAGE = 0.97;

/**
 * σ for the viability pipeline, reworked per audit §1.4:
 *
 *  1. COVERAGE is no longer discarded — degraded ingestion refuses the
 *     estimate (the guarded contract the regime updater already keeps).
 *  2. The in-progress trailing candle is DROPPED — annualising a
 *     partial day as a full one biased σ low (~0.8% at mid-day).
 *  3. Garman–Klass OHLC is PRIMARY (~7.4× the efficiency of
 *     close-to-close: 30 days buys ~200 close-days of precision, from
 *     high/low data we already fetch), and σ ships its own 90% band.
 *     Close-to-close survives only as a LABELLED fallback for corrupt
 *     OHLC, with the analytic band σ·(1 ± 1.645/√(2n)).
 */
/**
 * D5 tenor adjustment: σ_weekly-nonoverlap(1y) ÷ σ_daily-same-method(1y).
 * Best-effort — null (unadjusted, labelled) on any missing input.
 */
async function tenorAdjustFor(
  method: SigmaEstimate["method"],
): Promise<SigmaEstimate["tenorAdjust"]> {
  try {
    const { candles, coverage } = await getSolDailyCandles(EMPIRICAL_WINDOW_DAYS);
    if (coverage.coverageRatio < SIGMA_MIN_COVERAGE) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const complete =
      candles.length > 0 && candles[candles.length - 1].t + 86_400 > nowSec
        ? candles.slice(0, -1)
        : candles;
    const closes = complete.map((c) => c.c);
    const weekly = computeNonOverlappingTenorVol(closes, 7, { minReturns: 40 });
    const vr = varianceRatio(closes, 7);
    if (!weekly || !vr) return null;
    // Denominator matches the base estimator's method so the ratio is a
    // pure scale correction, not a method switch in disguise.
    const daily =
      method === "garman-klass"
        ? computeGarmanKlassVol(complete, "1D", { minCandles: 300 })?.sigma
        : computeRealizedVol(complete, "1D", { minReturns: 300 })?.sigma;
    if (!daily || !(daily > 0)) return null;
    return {
      ratio: weekly.sigmaAnnual / daily,
      weeklySigma1y: weekly.sigmaAnnual,
      weeklyN: weekly.n,
      dailySigma1y: daily,
      varianceRatio7: vr.ratio,
    };
  } catch (error) {
    console.error(
      "[viability] tenor adjustment unavailable (serving unadjusted daily σ):",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * §1.8/F1: EXPORTED because the hedge QUOTE path prices with this same
 * estimator — the card and a live quote must never price FV at two
 * different σs (the regime updater's 15-minute close-to-close RV stays
 * as the IV/RV denominator and a transparency figure only).
 */
export async function solSigmaEstimate(): Promise<SigmaEstimate | null> {
  const { candles, coverage } = await getSolDailyCandles(CANDLE_WINDOW_DAYS);
  if (coverage.coverageRatio < SIGMA_MIN_COVERAGE) {
    console.error(
      `[viability] sigma refused: candle coverage ${(coverage.coverageRatio * 100).toFixed(1)}% ` +
        `(${coverage.received}/${coverage.expected} candles, ${coverage.gaps} gaps)`,
    );
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const complete =
    candles.length > 0 && candles[candles.length - 1].t + 86_400 > nowSec
      ? candles.slice(0, -1)
      : candles;

  // Daily-annualised base estimate (§1.4): GK preferred, CC fallback.
  let base:
    | { sigma: number; band: { p05: number; p95: number }; windowDays: 30 | 90; method: SigmaEstimate["method"]; nDays: number }
    | null = null;
  // The 30d window must be CONTIGUOUS daily bars — slicing a gappy
  // series would silently span more than 30 calendar days.
  const last30 = complete.slice(-30);
  const contiguous30 =
    last30.length === 30 &&
    last30.every((c, i) => i === 0 || c.t - last30[i - 1].t === 86_400);
  if (contiguous30) {
    const gk = computeGarmanKlassVol(last30, "1D");
    if (gk) base = { sigma: gk.sigma, band: gk.band, windowDays: 30, method: "garman-klass", nDays: gk.nDays };
  }
  if (!base) {
    const gk90 = computeGarmanKlassVol(complete, "1D");
    if (gk90) base = { sigma: gk90.sigma, band: gk90.band, windowDays: 90, method: "garman-klass", nDays: gk90.nDays };
  }
  if (!base) {
    const cc = (rv: RealizedVol, days: 30 | 90) => {
      const rel = 1.645 / Math.sqrt(2 * rv.nReturns);
      return {
        sigma: rv.sigma,
        band: { p05: rv.sigma * (1 - rel), p95: rv.sigma * (1 + rel) },
        windowDays: days,
        method: "close-to-close" as const,
        nDays: rv.nReturns,
      };
    };
    const rv30 = computeRealizedVol(complete.slice(-31), "1D");
    if (rv30) base = cc(rv30, 30);
    else {
      const rv90 = computeRealizedVol(complete, "1D");
      if (rv90) base = cc(rv90, 90);
    }
  }
  if (!base) return null;

  // D5: scale the current-regime daily estimate to the tenor. F4b (paper
  // verifier): the ratio is itself estimated from ~52 weekly returns —
  // its analytic relative half-width 1.645/√(2n) ≈ 16% is the largest
  // single σ-error term, so it combines per side in quadrature with the
  // base band instead of being treated as exact.
  const tenorAdjust = await tenorAdjustFor(base.method);
  const k = tenorAdjust?.ratio ?? 1;
  let band = { p05: base.band.p05 * k, p95: base.band.p95 * k };
  if (tenorAdjust) {
    const relRatio = 1.645 / Math.sqrt(2 * tenorAdjust.weeklyN);
    const relLo = Math.hypot(1 - base.band.p05 / base.sigma, relRatio);
    const relHi = Math.hypot(base.band.p95 / base.sigma - 1, relRatio);
    band = {
      p05: Math.max(0, base.sigma * k * (1 - relLo)),
      p95: base.sigma * k * (1 + relHi),
    };
  }
  return {
    sigma: base.sigma * k,
    band,
    windowDays: base.windowDays,
    method: base.method,
    nDays: base.nDays,
    sigmaDaily: base.sigma,
    tenorAdjust,
  };
}

/**
 * FV and E[ΔV] of the 7-day corridor payoff via the paper's §3.2
 * Simpson quadrature (§1.3) — deterministic, ~400 evaluations of the
 * SAME position-value function the card charts, over the same
 * risk-neutral GBM the hedge quote path integrates.
 *
 * Replaces the 20k-path seeded MC, which was adequate for FV (0.9% SE)
 * but hopeless for E[ΔV]: unclamped, its variance is dominated by a
 * linear term whose expectation is exactly zero, giving 8–108% SE —
 * VI₂ for one real position spanned 3.90–12.66 on the seed alone
 * (audit D-1/F2/F6). The same linear term costs the quadrature nothing
 * (martingale identity, resolved to ~1e-9).
 */
function fairValueCore(
  view: PortfolioPositionView,
  sigma: number,
): { fairValueUsd: number; expectedValueChangeUsd: number } {
  const v0 = positionValueAtPrice(view, view.price);
  const tenorYears = TENOR_SECONDS / SECONDS_PER_YEAR;
  // §3.1 asserts FV >= 0. That proof needs S0 inside [p_l, p_u]: below
  // the range, V(S0) < V(p_l) <= V(clamp(S_T)) pointwise, so the raw
  // integral is negative and would INFLATE the floor-branch breakeven
  // (P_floor - FV)/(1-y). Clamped at zero exactly like
  // computeQuadratureFV and @lh/hedge's pricing.
  const fairValueUsd = Math.max(
    0,
    quadratureExpectation(
      (sT) =>
        v0 -
        positionValueAtPrice(
          view,
          Math.min(Math.max(sT, view.priceLower), view.priceUpper),
        ),
      view.price,
      sigma,
      tenorYears,
    ),
  );
  // E[ΔV] = E[V(S_T)] − V(S_0), NOT clamped — a mark-to-market
  // expectation, legitimately negative (that is the divergence loss),
  // which is what the paper's two-sided breakeven needs (§2.4.4).
  const expectedValueChangeUsd = quadratureExpectation(
    (sT) => positionValueAtPrice(view, sT) - v0,
    view.price,
    sigma,
    tenorYears,
  );
  return { fairValueUsd, expectedValueChangeUsd };
}

/** §1.6: E[ΔV] under ±DRIFT_SWEEP_ANNUAL physical drift — display only
 *  (the point estimate stays risk-neutral); computed once per position,
 *  never inside the §1.7 perturbation legs. */
function driftSweep(
  view: PortfolioPositionView,
  sigma: number,
): { atMinus: number; atPlus: number } {
  const v0 = positionValueAtPrice(view, view.price);
  const tenorYears = TENOR_SECONDS / SECONDS_PER_YEAR;
  const deltaV = (sT: number) => positionValueAtPrice(view, sT) - v0;
  return {
    atMinus: quadratureExpectation(
      deltaV, view.price, sigma, tenorYears, undefined, -DRIFT_SWEEP_ANNUAL,
    ),
    atPlus: quadratureExpectation(
      deltaV, view.price, sigma, tenorYears, undefined, DRIFT_SWEEP_ANNUAL,
    ),
  };
}

/**
 * §1.7: combine per-source index perturbations into one asymmetric 90%
 * band. Each leg holds the index re-evaluated at one input's band
 * edges; per-source half-widths combine in quadrature (the three
 * sources — σ estimation, in-range sampling, fee-flow sampling — are
 * independent). A leg value of +Infinity (a perturbation pushed the
 * breakeven to zero) makes the UPPER edge unbounded (p95 = null);
 * NaN/−Infinity anywhere voids the band. Exported pure for tests.
 */
export function combineIndexBands(
  point: number | null,
  legs: number[][],
): { p05: number; p95: number | null } | null {
  if (point === null || !Number.isFinite(point)) return null;
  let lo2 = 0;
  let hi2 = 0;
  let unboundedHi = false;
  for (const leg of legs) {
    let lo = 0;
    let hi = 0;
    for (const v of leg) {
      if (Number.isNaN(v)) return null;
      if (v === Number.POSITIVE_INFINITY) {
        unboundedHi = true;
        continue;
      }
      if (!Number.isFinite(v)) return null;
      if (v < point) lo = Math.max(lo, point - v);
      else hi = Math.max(hi, v - point);
    }
    lo2 += lo * lo;
    hi2 += hi * hi;
  }
  return {
    p05: Math.max(0, point - Math.sqrt(lo2)),
    p95: unboundedHi ? null : point + Math.sqrt(hi2),
  };
}

/**
 * Viability for one SOL/USDC position. Returns null (never a guess) when
 * any input is unavailable; the reason is logged server-side only.
 */
export async function computePositionViability(
  view: PortfolioPositionView,
  whirlpool: WhirlpoolData,
  inputs: ViabilityInputs,
): Promise<PositionViabilityWire | null> {
  const sigmaEstimate = inputs.sigma;
  const markup = inputs.markup;
  try {
    if (view.valueQuote <= 0) return null;

    const basis = await poolYieldBasis(view, whirlpool);
    // Null means an input was unavailable — report nothing rather than a
    // substituted value the card would label "measured".
    if (!basis) return null;
    const { concentrationFactor: c } = basis;

    const { sigma, windowDays } = sigmaEstimate;
    // The GBM in-range fraction now uses the range's ACTUAL bounds rather
    // than a half-width re-centred on spot. The old form reported a
    // position as ~98% in range while its price sat entirely outside the
    // range, and that fraction multiplies straight into measuredDailyYield
    // — the numerator of BOTH viability indices.
    // F5: DISCRETE steps 1..N — the same estimand as the empirical
    // estimator (daily closes), so the divergence flag compares
    // like-for-like in time-sampling too, not only in bounds.
    const gbmFractionBounds = inRangeFractionBoundsDiscrete(
      view.priceLower,
      view.priceUpper,
      view.price,
      sigma,
      TENOR_DAYS,
    );
    const poolDaily = basis.poolDailyYield;

    // Estimator policy (2026-07-08): empirical is PRIMARY when history
    // allows, GBM analytic is the pricing-consistent reference,
    // disagreement is surfaced (never averaged), and the method used is
    // labeled on the wire for verbatim display in the UI.
    const { empirical, reason } = await loadEmpiricalInRange(
      view.priceLower,
      view.priceUpper,
      view.price,
      TENOR_DAYS, // 7 daily steps — the 7-day tenor
    );
    const inRangeEstimate = composeInRangeEstimate({
      empirical,
      gbm: { fraction: gbmFractionBounds, sigmaAnnual: sigma },
      ...(reason ? { empiricalUnavailableReason: reason } : {}),
    });

    // §1.2 (audit-revised): when enough feeGrowthInside history exists,
    // the realised IN-RANGE intensity replaces r_pool × c — the measured
    // legs — while the in-range fraction stays the FORWARD estimate.
    // E[F] and both indices are forward quantities; a trailing occupancy
    // here would credit a position that left its range days ago with its
    // historic yield (the audits' top semantic finding). The fully
    // modelled chain remains as the labelled fallback.
    const realised = await readRealisedPositionYield(view);
    const inRangeRate = realised.ok ? realised.inRangeDailyRate : poolDaily * c;

    // §1.7: ONE evaluation path for the point estimate and every
    // perturbation leg — two implementations would make the band
    // meaningless. (σ, fraction, rate) → both indices + intermediates.
    const evaluateIndices = (sigmaX: number, fractionX: number, rateX: number) => {
      const { fairValueUsd, expectedValueChangeUsd } = fairValueCore(view, sigmaX);
      const measured = rateX * fractionX;
      const r = computeViability({
        fairValueUsd,
        // §1.8: the LIVE markup the quote path applies — no more
        // hardcoded 1.08 pricing a certificate nobody would be quoted.
        effectiveMarkup: markup.effectiveMarkup,
        premiumFloorUsd: PREMIUM_FLOOR_USD,
        feeSplitRate: FEE_SPLIT_RATE,
        positionValueUsd: view.valueQuote,
        tenorDays: TENOR_DAYS,
        measuredDailyYield: measured,
      });
      // Paper §2.4.4 two-sided breakeven — the index that DOES count
      // divergence loss. Premium at the measured fee yield, matching
      // the paper's use of realised premiums.
      const expectedFeesUsd = view.valueQuote * measured * TENOR_DAYS;
      const premiumUsd = Math.max(
        PREMIUM_FLOOR_USD,
        fairValueUsd * markup.effectiveMarkup - FEE_SPLIT_RATE * expectedFeesUsd,
      );
      const ts = computeTwoSidedViability({
        expectedValueChangeUsd,
        premiumUsd,
        protocolFeeRate: PROTOCOL_FEE_RATE,
        positionValueUsd: view.valueQuote,
        tenorDays: TENOR_DAYS,
        measuredDailyYield: measured,
      });
      return { fairValueUsd, expectedValueChangeUsd, measured, result: r, premiumUsd, twoSided: ts };
    };

    const point = evaluateIndices(sigma, inRangeEstimate.fraction, inRangeRate);
    const { fairValueUsd, expectedValueChangeUsd, result, premiumUsd, twoSided } = point;
    const measuredDailyYield = point.measured;
    const { atMinus: expectedValueChangeUsdAtMinusDrift, atPlus: expectedValueChangeUsdAtPlusDrift } =
      driftSweep(view, sigma);

    // A NaN anywhere upstream used to travel as `null`, which the card
    // reads as "unbounded" and paints GREEN — a silent numeric failure
    // displayed as the strongest possible pass. Refuse instead.
    if (!Number.isFinite(fairValueUsd) || !Number.isFinite(expectedValueChangeUsd)) {
      console.error(
        `[viability] non-finite FV/E[dV] for ${view.positionAddress} — ` +
          `reporting unavailable`,
      );
      return null;
    }
    if (!Number.isFinite(measuredDailyYield)) return null;

    // F2 (paper verifier) + D2b: Definition 2.2's FV ≥ 0 and both index
    // constructions assume S0 ∈ (p_l, p_u); the quote path refuses such
    // positions outright. Out of range the server therefore SUPPRESSES
    // the indices (nulls, rangeState flag) rather than serving numbers
    // computed through the clamp — and skips the perturbation legs.
    const inRangeForIndices = view.inRange;

    // §1.7: perturbation legs — each quantified input evaluated at its
    // own band edges through the same path as the point estimate.
    //  σ leg: FV and E[ΔV] move; the fraction moves too when the GBM
    //  analytic is primary (it is a function of σ), not when empirical.
    const sigmaLeg = (inRangeForIndices
      ? [sigmaEstimate.band.p05, sigmaEstimate.band.p95]
      : []
    ).map((s) =>
      evaluateIndices(
        s,
        inRangeEstimate.method === "gbm-analytic"
          ? inRangeFractionBoundsDiscrete(view.priceLower, view.priceUpper, view.price, s, TENOR_DAYS)
          : inRangeEstimate.fraction,
        inRangeRate,
      ),
    );
    //  in-range leg: empirical mean CI (absent on the GBM path — σ leg
    //  already carries that uncertainty).
    const fractionLeg = inRangeForIndices && inRangeEstimate.meanCi
      ? [inRangeEstimate.meanCi.p05, inRangeEstimate.meanCi.p95].map((f) =>
          evaluateIndices(sigma, f, inRangeRate),
        )
      : [];
    //  yield leg: realised fee bootstrap, or the measured pool yield
    //  bootstrap × c; EMPTY on the Birdeye fallback — that source's
    //  uncertainty is unquantified and the band says so (dominatedBy
    //  stays honest rather than pretending zero).
    const rateCi = realised.ok
      ? realised.inRangeDailyRateCi
      : basis.poolDailyYieldCi
        ? { p05: basis.poolDailyYieldCi.p05 * c, p95: basis.poolDailyYieldCi.p95 * c }
        : null;
    const rateLeg = inRangeForIndices && rateCi
      ? [rateCi.p05, rateCi.p95].map((r) => evaluateIndices(sigma, inRangeEstimate.fraction, r))
      : [];

    const legIndex = (leg: ReturnType<typeof evaluateIndices>[], pick: "vi1" | "vi2") =>
      leg.map((e) => (pick === "vi1" ? e.result.viabilityIndex : e.twoSided.viabilityIndex));
    const vi1Point = Number.isFinite(result.viabilityIndex) ? result.viabilityIndex : null;
    const vi2Point = Number.isFinite(twoSided.viabilityIndex) ? twoSided.viabilityIndex : null;
    const viabilityIndexBand = combineIndexBands(vi1Point, [
      legIndex(sigmaLeg, "vi1"),
      legIndex(fractionLeg, "vi1"),
      legIndex(rateLeg, "vi1"),
    ]);
    const twoSidedIndexBand = combineIndexBands(vi2Point, [
      legIndex(sigmaLeg, "vi2"),
      legIndex(fractionLeg, "vi2"),
      legIndex(rateLeg, "vi2"),
    ]);
    // Which source dominates the band (largest finite excursion across
    // both indices) — the reader's cue for what would tighten it.
    const spans: [string, number][] = (
      [
        ["sigma", sigmaLeg],
        ["in-range", fractionLeg],
        ["yield", rateLeg],
      ] as const
    ).map(([name, leg]) => {
      let span = 0;
      for (const e of leg) {
        for (const [p, v] of [
          [vi1Point, e.result.viabilityIndex],
          [vi2Point, e.twoSided.viabilityIndex],
        ] as const) {
          if (p !== null && Number.isFinite(v)) span = Math.max(span, Math.abs(v - p));
        }
      }
      return [name, span];
    });
    spans.sort((a, b) => b[1] - a[1]);
    const uncertaintyDominatedBy =
      spans[0][1] > 0 ? (spans[0][0] as "sigma" | "in-range" | "yield") : null;

    // The wire encodes Infinity→null for the two INDICES deliberately
    // (null = unbounded), and the card renders null as the strongest
    // pass — the exact shape of the historic NaN→null→green bug. Every
    // OTHER numeric must therefore be finite or the record is refused;
    // JSON.stringify would otherwise smuggle a NaN through as null.
    const mustBeFinite = [
      result.breakevenDailyYield,
      twoSided.breakevenDailyYield,
      twoSided.unhedgedBreakevenDailyYield,
      twoSided.protocolFeeWedgeDailyYield,
      twoSided.expectedValueChangeUsd,
      premiumUsd,
    ];
    if (!mustBeFinite.every(Number.isFinite)) {
      console.error(
        `[viability] non-finite breakeven/premium for ${view.positionAddress} — ` +
          `reporting unavailable`,
      );
      return null;
    }

    appendPredictionLog({
      v: 2,
      ts: new Date().toISOString(),
      whirlpool: view.whirlpool,
      position: view.positionAddress,
      priceLower: view.priceLower,
      priceUpper: view.priceUpper,
      spot: view.price,
      horizonDays: TENOR_DAYS,
      gbmFraction: gbmFractionBounds,
      gbmSigma: sigma,
      empiricalMean: empirical ? empirical.mean : null,
      empiricalMeanCi: empirical?.meanCi ?? null,
      empiricalWindows: empirical ? empirical.windows : null,
      empiricalNEffective: empirical?.nEffective ?? null,
      methodUsed: inRangeEstimate.method,
      fractionUsed: inRangeEstimate.fraction,
    });

    return {
      // D2b/F2: consumers MUST branch on rangeState before interpreting
      // a null index — out of range, null means SUPPRESSED (the indices
      // assume in-range comparability); in range, null encodes Infinity.
      rangeState: view.inRange ? ("in-range" as const) : ("out-of-range" as const),
      // Infinity (zero breakeven) does not survive JSON — null encodes it.
      viabilityIndex:
        inRangeForIndices && Number.isFinite(result.viabilityIndex)
          ? result.viabilityIndex
          : null,
      // §1.7: 90% band from the three quantified input uncertainties,
      // combined in quadrature through the SAME evaluation path.
      viabilityIndexBand: inRangeForIndices ? viabilityIndexBand : null,
      uncertaintyDominatedBy: inRangeForIndices ? uncertaintyDominatedBy : null,
      breakevenDailyYield: result.breakevenDailyYield,
      measuredDailyYield,
      bound: result.bound,
      // Second index: includes divergence loss (paper §2.4.3-2.4.4).
      twoSided: {
        viabilityIndex:
          inRangeForIndices && Number.isFinite(twoSided.viabilityIndex)
            ? twoSided.viabilityIndex
            : null,
        viabilityIndexBand: inRangeForIndices ? twoSidedIndexBand : null,
        breakevenDailyYield: twoSided.breakevenDailyYield,
        unhedgedBreakevenDailyYield: twoSided.unhedgedBreakevenDailyYield,
        protocolFeeWedgeDailyYield: twoSided.protocolFeeWedgeDailyYield,
        expectedValueChangeUsd: twoSided.expectedValueChangeUsd,
        premiumUsd,
      },
      fairValueUsd,
      sigmaAnnualized: sigma,
      sigmaWindowDays: windowDays,
      // §1.4: σ's own uncertainty and provenance travel with it.
      sigmaBand: sigmaEstimate.band,
      sigmaMethod: sigmaEstimate.method,
      sigmaDays: sigmaEstimate.nDays,
      // D5: the tenor scaling and its evidence, or null = unadjusted.
      sigmaDaily: sigmaEstimate.sigmaDaily,
      sigmaTenorAdjust: sigmaEstimate.tenorAdjust,
      // §1.8: the parameters this card actually priced with — the same
      // ones a quote would use (C6 partial; C5 groundwork via ivSource).
      pricingParams: {
        effectiveMarkup: markup.effectiveMarkup,
        ivRvRatio: markup.ivRvRatio,
        ivSource: markup.ivSource,
        ivFallbackUsed: markup.ivFallbackUsed,
        markupFloor: PRICING.markupFloor,
        feeSplitRate: FEE_SPLIT_RATE,
        premiumFloorUsd: PREMIUM_FLOOR_USD,
        protocolFeeRate: PROTOCOL_FEE_RATE,
        tenorDays: TENOR_DAYS,
      },
      // §1.6: E[ΔV] under ±50%/yr physical drift — the reader must see
      // the estimate is drift-determined; the point stays risk-neutral.
      driftSensitivity: {
        sweepAnnual: DRIFT_SWEEP_ANNUAL,
        expectedValueChangeUsdAtMinus: expectedValueChangeUsdAtMinusDrift,
        expectedValueChangeUsdAtPlus: expectedValueChangeUsdAtPlusDrift,
      },
      poolDailyYield: poolDaily,
      // §1.1 provenance: which source produced poolDailyYield, over what
      // window, and why the fallback was used when it was. The UI shows
      // this verbatim — a modelled number must never look measured.
      poolYield: {
        source: basis.source,
        coveredSeconds: basis.window?.coveredSeconds ?? null,
        windowSeconds: basis.window?.windowSeconds ?? null,
        intervals: basis.window?.intervals ?? null,
        lastT: basis.window?.lastT ?? null,
        fallbackReason: basis.fallbackReason,
        tvlSource: basis.tvlSource,
      },
      // §1.2 provenance: whether the measured legs of measuredDailyYield
      // are the position's own realised in-range intensity or the
      // modelled r_pool × c (the in-range fraction is forward either way).
      positionYield: realised.ok
        ? {
            source: "realised-inside",
            coveredSeconds: realised.measured.coveredSeconds,
            windowSeconds: realised.measured.windowSeconds,
            intervals: realised.measured.intervals,
            inRangeSeconds: realised.measured.inRangeSeconds,
            feesUsd: realised.measured.feesQuote,
            lastT: realised.measured.lastT,
            fallbackReason: null,
          }
        : {
            source: "modelled-chain",
            coveredSeconds: null,
            windowSeconds: null,
            intervals: null,
            inRangeSeconds: null,
            feesUsd: null,
            lastT: null,
            fallbackReason: realised.reason,
          },
      inRangeFraction: inRangeEstimate.fraction,
      concentrationFactor: c,
      // §1.9: the sanity gate above refuses out-of-band c outright, so
      // a served c is measured by construction — stated on the wire.
      concentrationFactorSource: "measured" as const,
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

/** §1.8: batch inputs = σ estimate + the LIVE effective markup from the
 *  same market cache the quote path uses. */
export interface ViabilityInputs {
  sigma: SigmaEstimate;
  markup: EffectiveMarkupResult;
}

/**
 * Shared inputs for a batch of positions: null when Birdeye is not
 * configured or the candle/vol pipeline cannot deliver — every position
 * then reports "viability unavailable". The markup always resolves (its
 * failure mode is the markup floor, labelled).
 */
export async function loadViabilityInputs(): Promise<ViabilityInputs | null> {
  if (!birdeyeApiKey()) return null;
  try {
    const sigma = await solSigmaEstimate();
    if (!sigma) return null;
    return { sigma, markup: await getEffectiveMarkup() };
  } catch (error) {
    console.error(
      "[viability] sigma estimate unavailable:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
