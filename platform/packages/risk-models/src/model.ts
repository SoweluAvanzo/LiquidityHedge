/**
 * The RiskModel port (AR-5) — v1.0.0, versioned and stable.
 *
 * Contract (NFR-E1, enables future third-party model sandboxing):
 *  - calibrate() and simulatePaths() are PURE: no I/O, no clocks, no
 *    global randomness — all entropy comes from the seed in the grid.
 *  - Same (params, grid) ⇒ bit-identical PricePaths.
 *  - configSchema is a JSON Schema; the UI renders model config forms
 *    from it generically (FR-S5) — adding a model requires no UI change.
 */

export const RISK_MODEL_PORT_VERSION = "1.0.0";

export interface AssetSeries {
  assetId: string;
  /** Close prices, oldest first, uniform spacing. */
  closes: number[];
  /** Spacing of the series in seconds (e.g. 86400 for daily). */
  stepSeconds: number;
}

export interface SimulationGrid {
  horizonSteps: number;
  stepSeconds: number;
  nPaths: number;
  seed: number;
}

export interface PricePaths {
  assetIds: string[];
  nPaths: number;
  /** steps INCLUDING t=0: prices[asset][path][0] === S0. */
  steps: number;
  prices: number[][][];
}

export interface RiskModelDescriptor {
  id: string;
  version: string;
  label: string;
  /** JSON Schema for the model's config object. */
  configSchema: Record<string, unknown>;
}

export interface RiskModel<P = unknown, C = unknown> {
  describe(): RiskModelDescriptor;
  calibrate(history: AssetSeries[], config: C): P;
  simulatePaths(params: P, grid: SimulationGrid): PricePaths;
}

export const SECONDS_PER_YEAR = 365 * 86_400;

/** Aligned per-step log-return vectors across assets (joint sampling basis). */
export function jointLogReturns(history: AssetSeries[]): number[][] {
  if (history.length === 0) throw new Error("no asset history");
  const n = Math.min(...history.map((h) => h.closes.length));
  if (n < 2) throw new Error("history too short");
  const steps = n - 1;
  const out: number[][] = [];
  for (let i = 0; i < steps; i++) {
    const vec: number[] = [];
    for (const h of history) {
      // Align tails: use the LAST n closes of each series.
      const closes = h.closes.slice(h.closes.length - n);
      const prev = closes[i];
      const cur = closes[i + 1];
      if (!(prev > 0) || !(cur > 0)) {
        throw new Error(`non-positive close in ${h.assetId}`);
      }
      vec.push(Math.log(cur / prev));
    }
    out.push(vec);
  }
  return out;
}

export function lastCloses(history: AssetSeries[]): number[] {
  return history.map((h) => h.closes[h.closes.length - 1]);
}
