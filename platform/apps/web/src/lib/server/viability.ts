/**
 * Per-position Viability Index (FR-M8), computed server-side for
 * /api/portfolio on each SOL/USDC position:
 *
 *   measuredDailyYield — pool daily yield × in-range fraction × on-chain
 *                        concentration factor. The pool yield is MEASURED
 *                        from our own feeGrowthGlobal snapshots (§1.1)
 *                        when coverage allows, with the Birdeye
 *                        volume-model retained only as a labelled
 *                        fallback; provenance travels on the wire. The
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
  computeTwoSidedViability,
  positionValueAtPrice,
} from "@lh/portfolio";
import {
  computeRealizedVol,
  empiricalInRangeFractionBounds,
} from "@lh/market-data";
import { quadratureExpectation } from "@lh/core/src/pricing-engine/pricing";
import { SECONDS_PER_YEAR } from "@lh/core/src/types";
import type { WhirlpoolData } from "@lh/core/src/market-data/decoder";
import {
  computeConcentrationFactor,
  estimatePoolDailyYield,
  inRangeFractionBounds,
  lpFeeTier,
  type PoolOverview,
} from "@lh/core/src/market-data/orca-volume-adapter";
import { getPoolOverview, getSolDailyCandles, birdeyeApiKey } from "./birdeye";
import { readMeasuredPoolYield } from "./pool-yield";
import { readRealisedPositionYield } from "./position-yield";
import type { PositionViabilityWire } from "@/lib/portfolio-api";
import { numericEnv } from "@lh/storage";

const TENOR_DAYS = 7;
const TENOR_SECONDS = TENOR_DAYS * 86_400;
const EFFECTIVE_MARKUP = 1.08;
const PREMIUM_FLOOR_USD =
  numericEnv("HEDGE_PREMIUM_FLOOR_USDC", 50_000) / 1e6;
/** Protocol treasury fee φ — the only leakage in the paper's §2.4.2
 * redistribution identity, and the whole of Corollary 2.1's wedge. */
const PROTOCOL_FEE_RATE = numericEnv("HEDGE_PROTOCOL_FEE_RATE", 0.015);
const FEE_SPLIT_RATE = 0.1;

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

interface SigmaEstimate {
  sigma: number;
  windowDays: 30 | 90;
}

/** §1.1 provenance-carrying yield basis — see poolYieldBasis below. */
export interface PoolYieldBasis {
  /** The pool daily yield actually used downstream. */
  poolDailyYield: number;
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

/**
 * Realized vol from ingested daily candles: 30d window preferred, 90d
 * fallback; null when even 90d cannot support a vol estimate.
 */
async function solSigmaEstimate(): Promise<SigmaEstimate | null> {
  const { candles } = await getSolDailyCandles(CANDLE_WINDOW_DAYS);
  const last31 = candles.slice(-31); // 30 daily returns
  const rv30 = computeRealizedVol(last31, "1D");
  if (rv30) return { sigma: rv30.sigma, windowDays: 30 };
  const rv90 = computeRealizedVol(candles, "1D");
  if (rv90) return { sigma: rv90.sigma, windowDays: 90 };
  return null;
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
function fairValueQuadrature(
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

    const basis = await poolYieldBasis(view, whirlpool);
    // Null means an input was unavailable — report nothing rather than a
    // substituted value the card would label "measured".
    if (!basis) return null;
    const { concentrationFactor: c } = basis;

    // Symmetric-width equivalent of the position's range around the
    // current price (the adapter's in-range model is symmetric in w).
    const widthBps = Math.max(
      1,
      ((view.priceUpper - view.priceLower) / 2 / view.price) * 10_000,
    );

    const { sigma, windowDays } = sigmaEstimate;
    // The GBM in-range fraction now uses the range's ACTUAL bounds rather
    // than a half-width re-centred on spot. The old form reported a
    // position as ~98% in range while its price sat entirely outside the
    // range, and that fraction multiplies straight into measuredDailyYield
    // — the numerator of BOTH viability indices.
    const gbmFractionBounds = inRangeFractionBounds(
      view.priceLower,
      view.priceUpper,
      view.price,
      sigma,
      TENOR_SECONDS,
    );
    const poolDaily = basis.poolDailyYield;

    // Empirical estimator width: half-width as a fraction of the range
    // MIDPOINT. The GBM side now integrates the ACTUAL bounds, so the two
    // are no longer forced onto one symmetric convention — but the
    // divergence metric below compares them, and a previous comment here
    // wrongly claimed they already used the same width. They differ by
    // exactly price/midpoint, which manufactured "model divergence" for
    // any position sitting off its own midpoint.
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
    const measuredDailyYield =
      (realised.ok ? realised.inRangeDailyRate : poolDaily * c) *
      inRangeEstimate.fraction;

    const { fairValueUsd, expectedValueChangeUsd } = fairValueQuadrature(view, sigma);
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

    const result = computeViability({
      fairValueUsd,
      effectiveMarkup: EFFECTIVE_MARKUP,
      premiumFloorUsd: PREMIUM_FLOOR_USD,
      feeSplitRate: FEE_SPLIT_RATE,
      positionValueUsd: view.valueQuote,
      tenorDays: TENOR_DAYS,
      measuredDailyYield,
    });

    // Paper §2.4.4 two-sided breakeven — the index that DOES count
    // divergence loss. Premium is evaluated at the measured fee yield,
    // matching the paper's use of realised premiums.
    const expectedFeesUsd = view.valueQuote * measuredDailyYield * TENOR_DAYS;
    const premiumUsd = Math.max(
      PREMIUM_FLOOR_USD,
      fairValueUsd * EFFECTIVE_MARKUP - FEE_SPLIT_RATE * expectedFeesUsd,
    );
    const twoSided = computeTwoSidedViability({
      expectedValueChangeUsd,
      premiumUsd,
      protocolFeeRate: PROTOCOL_FEE_RATE,
      positionValueUsd: view.valueQuote,
      tenorDays: TENOR_DAYS,
      measuredDailyYield,
    });

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
      ts: new Date().toISOString(),
      whirlpool: view.whirlpool,
      priceLower: view.priceLower,
      priceUpper: view.priceUpper,
      widthBps: empiricalWidthBps,
      horizonDays: TENOR_DAYS,
      gbmFraction: gbmFractionBounds,
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
      // Second index: includes divergence loss (paper §2.4.3-2.4.4).
      twoSided: {
        viabilityIndex: Number.isFinite(twoSided.viabilityIndex)
          ? twoSided.viabilityIndex
          : null,
        breakevenDailyYield: twoSided.breakevenDailyYield,
        unhedgedBreakevenDailyYield: twoSided.unhedgedBreakevenDailyYield,
        protocolFeeWedgeDailyYield: twoSided.protocolFeeWedgeDailyYield,
        expectedValueChangeUsd: twoSided.expectedValueChangeUsd,
        premiumUsd,
      },
      fairValueUsd,
      sigmaAnnualized: sigma,
      sigmaWindowDays: windowDays,
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
