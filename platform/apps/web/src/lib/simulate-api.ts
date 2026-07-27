/**
 * Wire types for /api/simulate — shared by the route handler and the
 * Simulate UI. The SimulationReport from @lh/risk-models is plain numbers,
 * so it crosses the wire unchanged.
 */

import type {
  Composition,
  CorrelationReport,
  RiskModelDescriptor,
  SimulationReport,
} from "@lh/risk-models";

export const SIM_WINDOW_DAYS = [365, 730, 1095] as const;
export type SimWindowDays = (typeof SIM_WINDOW_DAYS)[number];

export const SIM_MAX_PATHS = 5000;
export const SIM_MIN_PATHS = 100;

export const SIM_COMPOSITIONS = ["value", "value+yield", "yield"] as const;

/** Fee-rate override bounds, %/day (in-range-conditional). */
export const SIM_FEE_RATE_OVERRIDE_MAX_PCT = 5;

/** POST /api/simulate request body. */
export interface SimulateRequest {
  owner: string;
  modelId: string;
  config: Record<string, unknown>;
  windowDays: SimWindowDays;
  horizonWeeks: number;
  nPaths: number;
  seed: number;
  hedged: boolean;
  /** Quoted premium per certificate, USD (used when hedged). */
  premiumUsd?: number;
  /** Which component to simulate (default "value"). */
  composition?: Composition;
  /**
   * Optional IN-RANGE-CONDITIONAL fee rate override, %/day (0–5).
   * Used only when composition ≠ "value"; when omitted the server derives
   * the measured rate from the same viability pipeline as /api/portfolio.
   */
  feeRatePctPerDayOverride?: number;
  /**
   * Fee-intensity dynamics (composition ≠ "value" only; default "constant").
   * "stochastic" resamples the pool's historical daily volume SHAPE (block
   * bootstrap, deterministic under the run seed) so the yield rate
   * fluctuates along each path; the LEVEL is always anchored — to the
   * current measured rate, or to the override when one is given.
   */
  feeIntensityMode?: FeeIntensityMode;
  /**
   * How several assets are sampled together (default "joint").
   *
   * "joint"       — one resampled history is read across every asset, so
   *                 the paths carry the observed co-movement. This is the
   *                 correct setting for portfolio risk.
   * "independent" — each asset is drawn from its own distribution with an
   *                 independent seed. A DIAGNOSTIC: comparing it against
   *                 the joint run shows how much of the portfolio's
   *                 dispersion is co-movement. It understates tail risk
   *                 and must not be used as a risk figure on its own.
   *
   * Ignored for single-asset portfolios, where the two coincide.
   */
  sampling?: SamplingMode;
  /**
   * Also run the portfolio under the OTHER sampling mode and report the
   * difference (default false). Doubles the simulation, and is only
   * meaningful for multi-asset portfolios.
   */
  compareSampling?: boolean;
}

export type FeeIntensityMode = "constant" | "stochastic";
export type SamplingMode = "joint" | "independent";

/**
 * The same portfolio under joint and independent sampling.
 *
 * `dispersionRatio` < 1 means the measured correlation NARROWS the outcome
 * spread — genuine diversification, which is what negatively correlated
 * assets of comparable volatility produce. > 1 means co-movement widens
 * it, the usual case for assets that trade together. It is the honest
 * answer to "what is correlation worth to this portfolio", and it can land
 * on either side of 1.
 */
export interface CoMovementEffect {
  jointStd: number;
  independentStd: number;
  /** jointStd / independentStd. */
  dispersionRatio: number;
  /** 5th-percentile terminal P&L, both ways. */
  jointVar5: number;
  independentVar5: number;
  /** Mean of the worst 5%, both ways. */
  jointCvar5: number;
  independentCvar5: number;
  /** joint − independent at the 5% tail; negative = joint tail is worse. */
  var5DeltaUsd: number;
}

/** Echo of the fee-intensity resolution (present when composition ≠ "value"). */
export interface FeeIntensityEcho {
  mode: FeeIntensityMode;
  /**
   * Data basis label, e.g. "birdeye-pool-volume shape (364d), level
   * anchored to current measured rate".
   */
  basis?: string;
  /** Mean position-level rate of the sampled paths, %/day. */
  meanRatePctPerDay?: number;
}

/** RESOLVED in-range-conditional fee rate for one simulated position. */
export interface ResolvedYieldRate {
  positionAddress: string;
  /** %/day WHILE in range (the engine consumes it ÷ 100). */
  ratePctPerDay: number;
  /** "measured" = snapshot-derived pool rate (§1.1); "modelled" = the
   *  Birdeye fallback — labelled so the echo never upgrades a model to
   *  a measurement; "override" = user-supplied. */
  source: "measured" | "modelled" | "override";
}

/**
 * Echo of the effective run configuration: the request with defaults
 * applied, plus the resolved per-position yield rates so a run's rate
 * inputs are always inspectable (present when composition ≠ "value").
 */
export interface SimulateEcho extends SimulateRequest {
  composition: Composition;
  yieldRates?: ResolvedYieldRate[];
  feeIntensity?: FeeIntensityEcho;
}

/** GET /api/simulate response — model catalog for generic form rendering. */
export interface SimulateModelsResponse {
  models: RiskModelDescriptor[];
}

/** POST /api/simulate response. */
export interface SimulateResponse {
  /** ISO timestamp of the run (server clock). */
  asOf: string;
  /**
   * Echo of the full effective configuration incl. seed (FR-S4): replaying
   * this exact object reproduces the report bit-identically (for measured
   * yield rates: identically up to market-data drift — replay the echoed
   * rate as `feeRatePctPerDayOverride` for a bit-identical rerun).
   */
  echo: SimulateEcho;
  /** Number of USD-quoted positions included in the run. */
  positionsCount: number;
  /**
   * Base mints simulated, in the asset order of the run. More than one
   * means the paths were drawn jointly, so the reported portfolio
   * dispersion carries the assets' historical co-movement.
   */
  assets: string[];
  /**
   * Return-correlation estimate over the calibration window, with a 95%
   * confidence interval and p-value per pair. Null when the run used no
   * market data (sigma override) or has a single asset.
   */
  correlation?: CorrelationReport | null;
  /** Sampling mode actually used. */
  sampling: SamplingMode;
  /**
   * Paths the model ACTUALLY ran. May be far below the requested nPaths:
   * historical replay is capped by the number of available windows, and
   * `mode:"latest"` runs exactly one. Echoing the request instead was
   * reporting "2,000 paths" over a single deterministic path, alongside a
   * std of 0 and VaR = CVaR.
   */
  executedPaths: number;
  /**
   * Present when `compareSampling` was requested on a multi-asset
   * portfolio: the same positions priced both ways, so the diversification
   * the measured correlation actually buys is a number rather than an
   * inference.
   */
  comovement?: CoMovementEffect | null;
  report: SimulationReport;
}

export interface SimulateError {
  error: string;
}
