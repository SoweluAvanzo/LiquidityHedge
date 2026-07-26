/**
 * Wire types for /api/simulate — shared by the route handler and the
 * Simulate UI. The SimulationReport from @lh/risk-models is plain numbers,
 * so it crosses the wire unchanged.
 */

import type {
  Composition,
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
}

export type FeeIntensityMode = "constant" | "stochastic";

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
  source: "measured" | "override";
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
  /** Number of SOL/USDC positions included in the run. */
  positionsCount: number;
  report: SimulationReport;
}

export interface SimulateError {
  error: string;
}
