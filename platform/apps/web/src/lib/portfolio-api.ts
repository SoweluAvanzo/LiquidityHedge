/**
 * Wire types for /api/portfolio — the JSON shape shared by the route handler
 * (serializer) and the dashboard (consumer). bigint fields of
 * `PortfolioPositionView` cross the wire as decimal strings.
 */

import type {
  InRangeEstimate,
  PortfolioPositionView,
  PortfolioSummary,
  ValueCurvePoint,
} from "@lh/portfolio";

/**
 * Viability Index snapshot for a SOL/USDC position (FR-M8).
 * Model-based: corridor breakeven vs measured fee yield — see the
 * product-design docs. Null on any card means "unavailable", never 0.
 */
export interface PositionViabilityWire {
  /**
   * D2b/F2: BRANCH ON THIS before interpreting any index. Out of range
   * the server suppresses both indices and their bands (they assume
   * in-range comparability and Definition 2.2's FV domain; the quote
   * path refuses such positions outright) — a null index then means
   * SUPPRESSED, never "unbounded pass". The transparency inputs
   * (yields, σ, fractions, E[ΔV], premium) remain served.
   */
  rangeState: "in-range" | "out-of-range";
  /** measured / breakeven; null encodes Infinity (zero breakeven) when
   *  in range, suppression when out of range (see rangeState). */
  viabilityIndex: number | null;
  /**
   * §1.7: 90% band on the index from the three quantified input
   * uncertainties (σ band, empirical in-range mean CI, fee-flow
   * bootstrap), each re-evaluated through the SAME computation as the
   * point estimate and combined in quadrature. p95 = null means a
   * perturbation drove the breakeven to zero (upper edge unbounded).
   * Null band = point is unbounded or a leg was unresolvable. The
   * verdict badge flips only when this band clears a threshold.
   */
  viabilityIndexBand: { p05: number; p95: number | null } | null;
  /** Which source contributes the largest excursion ("what would
   *  tighten this band"); null when no quantified source moved it. */
  uncertaintyDominatedBy: "sigma" | "in-range" | "yield" | null;
  /** Daily fee yield at which fees exactly cover the hedge cost. */
  breakevenDailyYield: number;
  /**
   * Position-level daily fee yield: realised in-range intensity (own
   * feeGrowthInside) or measured/modelled pool rate × c — see
   * positionYield.source — times the FORWARD in-range fraction.
   */
  measuredDailyYield: number;
  /** Which premium branch bound the breakeven. */
  bound: "formula" | "floor";
  /**
   * Paper §2.4.3–2.4.4 two-sided viability — the OTHER index.
   *
   * The fields above answer "do fees beat the hedge's markup drag?" and
   * contain NO ΔV term. This one answers "is the position viable at all,
   * for both sides, once divergence loss is counted?" and is therefore
   * materially stricter. Both are shown; neither replaces the other.
   */
  twoSided: {
    /** measured / r*; null encodes Infinity (position expected to gain). */
    viabilityIndex: number | null;
    /** §1.7 band — same construction as viabilityIndexBand. */
    viabilityIndexBand: { p05: number; p95: number | null } | null;
    /** r* = r_u + φP/(V·T). */
    breakevenDailyYield: number;
    /** r_u = −E[ΔV]/(V·T): fees vs divergence loss alone (φ = 0 case). */
    unhedgedBreakevenDailyYield: number;
    /** Corollary 2.1 wedge r* − r_u; the paper measures ≤ 0.8 bps/day at its §8.8 reference position. */
    protocolFeeWedgeDailyYield: number;
    /** E[ΔV] over the tenor, USD. Negative = expected divergence loss. */
    expectedValueChangeUsd: number;
    /** Premium at the measured fee yield, USD — the P in the wedge. */
    premiumUsd: number;
  };
  /** Fair value of the 7-day corridor payoff, USD — deterministic
   * Simpson quadrature under risk-neutral GBM (§1.3), same method as
   * the hedge quote path; no sampling noise. */
  fairValueUsd: number;
  /** Annualized σ actually priced with (tenor-adjusted; see sigmaTenorAdjust) — feeds the quadrature FV/E[ΔV] and the GBM in-range reference. */
  sigmaAnnualized: number;
  /** Realized-vol lookback actually used (30d preferred, 90d fallback). */
  sigmaWindowDays: 30 | 90;
  /**
   * §1.4: σ's own 90% interval (p05/p95) — block bootstrap on the
   * Garman–Klass path, analytic 1/√(2n) on the close-to-close fallback,
   * COMBINED in quadrature with the D5 tenor-ratio's own sampling error
   * (n≈52 weekly returns). Propagated into the index bands (§1.7).
   */
  sigmaBand: { p05: number; p95: number };
  /** "garman-klass" = OHLC estimator (~7.4× close-to-close efficiency);
   *  "close-to-close" = labelled fallback for corrupt OHLC. */
  sigmaMethod: "garman-klass" | "close-to-close";
  /** Observations integrated: bars on the GK path, returns (bars−1) on the CC fallback; the in-progress day is always dropped. */
  sigmaDays: number;
  /** Unadjusted daily-annualised σ (before the D5 tenor scaling). */
  sigmaDaily: number;
  /**
   * Owner decision D5: sigmaAnnualized = sigmaDaily × ratio, because
   * the corridor payoff depends on TENOR-scale dispersion and SOL
   * mean-reverts weekly (VR(7) ≈ 0.76 over 1y — daily-annualised
   * estimators overstate 7-day terminal dispersion). ratio =
   * σ_weekly-nonoverlap(1y) ÷ σ_same-method-daily(1y). Null = 1y
   * history unavailable, unadjusted daily σ served.
   */
  sigmaTenorAdjust: {
    ratio: number;
    weeklySigma1y: number;
    weeklyN: number;
    dailySigma1y: number;
    varianceRatio7: number;
  } | null;
  /**
   * §1.6: E[ΔV] under ±sweepAnnual physical drift. The point estimate
   * is risk-neutral (pure concavity/divergence loss, no directional
   * view); this sweep shows how drift-determined the number is.
   */
  driftSensitivity: {
    sweepAnnual: number;
    expectedValueChangeUsdAtMinus: number;
    expectedValueChangeUsdAtPlus: number;
  };
  /**
   * §1.8: the premium parameters this card actually priced with — the
   * SAME values a live quote would use (shared getPricingParams module;
   * the dashboard previously hardcoded markup 1.08 and its own fee
   * split, A7/D-5). `ivSource`/`ivFallbackUsed` surface where the
   * markup's IV came from (C5 groundwork).
   */
  pricingParams: {
    effectiveMarkup: number;
    ivRvRatio: number;
    ivSource: string;
    ivFallbackUsed: boolean;
    markupFloor: number;
    feeSplitRate: number;
    premiumFloorUsd: number;
    protocolFeeRate: number;
    tenorDays: number;
  };
  poolDailyYield: number;
  /**
   * §1.1 provenance for poolDailyYield. "measured-snapshots" = derived
   * from our own 15-minute feeGrowthGlobal snapshots (the accumulator the
   * Whirlpool program pays LPs from; vendor-free, net of protocol fee by
   * construction) over the reported window. "modelled-birdeye" = the
   * legacy volume × LP-fee-tier ÷ TVL model, served whenever the
   * measured path cannot (short/stale coverage, no DATABASE_URL,
   * non-USD quote, broken accumulator) — fallbackReason states which.
   */
  poolYield: {
    source: "measured-snapshots" | "modelled-birdeye";
    /** Seconds actually integrated (gaps excluded); null when modelled. */
    coveredSeconds: number | null;
    /** Wall-clock span of the snapshot window; null when modelled. */
    windowSeconds: number | null;
    /** Snapshot intervals integrated; null when modelled. */
    intervals: number | null;
    /** Unix seconds of the measured window's END — staleness is gated
     *  server-side (~1h max) and stated here so clients can verify. */
    lastT: number | null;
    /** Why the modelled fallback was used; null on the measured path. */
    fallbackReason: string | null;
    /** TVL source for the concentration factor. */
    tvlSource: "onchain-vaults" | "birdeye";
  };
  /**
   * §1.2 provenance for the measured legs of measuredDailyYield.
   * "realised-inside" = the position's own realised IN-RANGE intensity,
   * L × Δ feeGrowthInside / 2⁶⁴ per in-range day over the reported
   * window (current-liquidity suffix only) — concentration and fee
   * competition measured; the in-range fraction stays the forward
   * estimate. "modelled-chain" = poolDailyYield × concentrationFactor,
   * used until enough position history exists.
   */
  positionYield: {
    source: "realised-inside" | "modelled-chain";
    coveredSeconds: number | null;
    windowSeconds: number | null;
    intervals: number | null;
    /** Covered seconds the position spent in range (realised only). */
    inRangeSeconds: number | null;
    /** Fees actually earned over the window, USD (realised only). */
    feesUsd: number | null;
    /** Unix seconds of the window's END (staleness gated server-side). */
    lastT: number | null;
    /** Why the modelled chain was used; null on the realised path. */
    fallbackReason: string | null;
  };
  /** The in-range fraction actually USED in measuredDailyYield (primary
   * estimator's value — see inRangeEstimate.method for which one). */
  inRangeFraction: number;
  /** Enters measuredDailyYield ONLY on the modelled chain; the realised
   * path measures concentration inside the position's own accumulator. */
  concentrationFactor: number;
  /** §1.9: provenance guard — "measured" is the ONLY value the server
   * emits (an out-of-band c refuses the whole record; the realised path
   * does not use c). On the wire so a substituted value could never
   * masquerade as measured if that policy ever regressed. */
  concentrationFactorSource: "measured" | "unavailable";
  tenorDays: number;
  /**
   * Estimator transparency (policy 2026-07-08): which estimator produced
   * the in-range fraction, its uncertainty band, the reference estimator
   * for side-by-side display, and a plain-language description the UI
   * must show VERBATIM. Composed by @lh/portfolio composeInRangeEstimate.
   */
  inRangeEstimate: InRangeEstimate;
  /** Rolling-window count behind the empirical estimator; null when the
   * empirical path was unavailable (GBM fallback). */
  empiricalWindows: number | null;
}

/** `PortfolioPositionView` with bigints as strings, plus the V(S) curve. */
export type PortfolioPositionWire = Omit<
  PortfolioPositionView,
  "liquidity" | "amountA" | "amountB" | "feeOwedA" | "feeOwedB"
> & {
  liquidity: string;
  amountA: string;
  amountB: string;
  /**
   * True when fees were reconstructed from the tick accounts (exact).
   * False/absent means only the position's stale checkpoint was readable,
   * which is a LOWER BOUND — the card must say so rather than imply the
   * figure is complete.
   */
  feesAreExact?: boolean;
  feeOwedA: string;
  feeOwedB: string;
  curve: ValueCurvePoint[];
  /** Viability Index — null when it cannot be measured (never faked). */
  viability: PositionViabilityWire | null;
};

export interface PortfolioResponse {
  /** ISO timestamp of when the snapshot was taken (server clock). */
  asOf: string;
  summary: PortfolioSummary;
  positions: PortfolioPositionWire[];
}

export interface PortfolioError {
  error: string;
}
