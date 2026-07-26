export interface Candle {
  /** Candle open time, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = "15m" | "1H" | "1D";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "15m": 900,
  "1H": 3600,
  "1D": 86_400,
};

/**
 * Coverage report for an ingestion run — the loud-not-silent contract (§E7):
 * consumers MUST check `complete` (or `coverageRatio`) before trusting
 * derived statistics like realized volatility.
 */
export interface CoverageReport {
  requestedFrom: number;
  requestedTo: number;
  received: number;
  /** Expected candle count for the span at this timeframe. */
  expected: number;
  /** received / expected, capped at 1. */
  coverageRatio: number;
  /** Number of internal gaps (missing steps between consecutive candles). */
  gaps: number;
  firstT: number | null;
  lastT: number | null;
  complete: boolean;
}

export interface OhlcvPage {
  items: Candle[];
}

/** Injectable transport so pagination logic is unit-testable offline. */
export type OhlcvFetcher = (params: {
  address: string;
  timeframe: Timeframe;
  timeFrom: number;
  timeTo: number;
}) => Promise<OhlcvPage>;
