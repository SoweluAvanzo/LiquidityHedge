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
  /** measured / breakeven; null encodes Infinity (zero breakeven). */
  viabilityIndex: number | null;
  /** Daily fee yield at which fees exactly cover the hedge cost. */
  breakevenDailyYield: number;
  /** Measured position-level daily fee yield (Birdeye × in-range × c). */
  measuredDailyYield: number;
  /** Which premium branch bound the breakeven. */
  bound: "formula" | "floor";
  /** MC fair value of the 7-day corridor payoff, USD. */
  fairValueUsd: number;
  /** Annualized realized vol used for the MC and in-range fraction. */
  sigmaAnnualized: number;
  /** Realized-vol lookback actually used (30d preferred, 90d fallback). */
  sigmaWindowDays: 30 | 90;
  poolDailyYield: number;
  /** The in-range fraction actually USED in measuredDailyYield (primary
   * estimator's value — see inRangeEstimate.method for which one). */
  inRangeFraction: number;
  concentrationFactor: number;
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
