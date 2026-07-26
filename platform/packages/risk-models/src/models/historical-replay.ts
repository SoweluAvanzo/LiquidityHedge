/**
 * Historical replay ("normal backtesting", FR-S1's third mode): the
 * portfolio is driven by ACTUAL past return paths — no distributional
 * assumption at all.
 *
 *   rolling — one path per rolling window of the horizon length inside
 *             the calibration window, each rebased to start at S₀
 *             (classic historical-simulation ensemble); deterministic.
 *   latest  — the single most recent path (a plain backtest replay).
 *
 * Deterministic by construction: the seed is unused, same inputs ⇒ same
 * paths (the port's determinism contract holds trivially).
 */

import {
  AssetSeries,
  PricePaths,
  RiskModel,
  RiskModelDescriptor,
  SimulationGrid,
  jointLogReturns,
  lastCloses,
} from "../model";

export type ReplayMode = "rolling" | "latest";

export interface ReplayConfig {
  mode: ReplayMode;
}

export interface ReplayParams {
  assetIds: string[];
  s0: number[];
  /** Historical joint log-return vectors [step][asset]. */
  returns: number[][];
  stepSeconds: number;
  mode: ReplayMode;
}

export class HistoricalReplayModel implements RiskModel<ReplayParams, ReplayConfig> {
  describe(): RiskModelDescriptor {
    return {
      id: "historical-replay",
      version: "1.0.0",
      label: "Historical replay (backtest, deterministic)",
      configSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["rolling", "latest"],
            default: "rolling",
            description:
              "rolling = every historical window of the horizon length, rebased to today (distribution); latest = single most recent path (plain backtest)",
          },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    };
  }

  calibrate(history: AssetSeries[], config: ReplayConfig): ReplayParams {
    const returns = jointLogReturns(history);
    return {
      assetIds: history.map((h) => h.assetId),
      s0: lastCloses(history),
      returns,
      stepSeconds: history[0].stepSeconds,
      mode: config.mode,
    };
  }

  simulatePaths(params: ReplayParams, grid: SimulationGrid): PricePaths {
    if (grid.stepSeconds !== params.stepSeconds) {
      throw new Error(
        `historical replay grid step (${grid.stepSeconds}s) must equal the ` +
          `historical return step (${params.stepSeconds}s)`,
      );
    }
    const H = grid.horizonSteps;
    const T = params.returns.length;
    if (T < H) {
      throw new Error(
        `calibration window too short: ${T} historical steps < horizon ${H} — ` +
          `use a longer window or a shorter horizon`,
      );
    }
    const nAssets = params.assetIds.length;

    // Window start indices, oldest→newest; evenly thinned if the caller's
    // path budget is smaller than the number of available windows.
    const available = T - H + 1;
    const starts: number[] =
      params.mode === "latest"
        ? [T - H]
        : available <= grid.nPaths
          ? Array.from({ length: available }, (_, i) => i)
          : Array.from({ length: grid.nPaths }, (_, i) =>
              Math.round((i * (available - 1)) / (grid.nPaths - 1)),
            );

    const prices: number[][][] = Array.from({ length: nAssets }, (_, a) =>
      starts.map((start) => {
        const path = new Array<number>(H + 1);
        path[0] = params.s0[a];
        for (let s = 1; s <= H; s++) {
          path[s] = path[s - 1] * Math.exp(params.returns[start + s - 1][a]);
        }
        return path;
      }),
    );

    return {
      assetIds: params.assetIds,
      nPaths: starts.length,
      steps: H + 1,
      prices,
    };
  }
}
