/**
 * Empirical bootstrap of historical JOINT log-return vectors (FR-S1/S2).
 * Sampling whole cross-asset vectors preserves the empirical correlation
 * structure by construction; block mode additionally preserves short-run
 * autocorrelation and volatility clustering.
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
import { makeRng } from "../rng";

export type BootstrapMode = "iid" | "block";

export interface BootstrapConfig {
  mode: BootstrapMode;
  /** Block length in steps (block mode), default 5. */
  blockLength?: number;
}

export interface BootstrapParams {
  assetIds: string[];
  s0: number[];
  /** Historical joint log-return vectors [step][asset]. */
  returns: number[][];
  /** Seconds per historical return step — the simulation grid must match. */
  stepSeconds: number;
  mode: BootstrapMode;
  blockLength: number;
}

export class EmpiricalBootstrapModel
  implements RiskModel<BootstrapParams, BootstrapConfig>
{
  describe(): RiskModelDescriptor {
    return {
      id: "empirical-bootstrap",
      version: "1.0.0",
      label: "Empirical bootstrap (historical returns, joint)",
      configSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["iid", "block"],
            default: "iid",
            description:
              "iid = independent resampling; block = contiguous blocks (preserves clustering)",
          },
          blockLength: {
            type: "integer",
            minimum: 2,
            maximum: 60,
            default: 5,
            description: "Block length in steps (block mode)",
          },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    };
  }

  calibrate(history: AssetSeries[], config: BootstrapConfig): BootstrapParams {
    const returns = jointLogReturns(history);
    if (returns.length < 30) {
      throw new Error(
        `bootstrap needs ≥30 historical returns, got ${returns.length}`,
      );
    }
    return {
      assetIds: history.map((h) => h.assetId),
      s0: lastCloses(history),
      returns,
      stepSeconds: history[0].stepSeconds,
      mode: config.mode,
      blockLength: config.blockLength ?? 5,
    };
  }

  simulatePaths(params: BootstrapParams, grid: SimulationGrid): PricePaths {
    if (grid.stepSeconds !== params.stepSeconds) {
      throw new Error(
        `bootstrap grid step (${grid.stepSeconds}s) must equal the historical ` +
          `return step (${params.stepSeconds}s) — resampling does not rescale time`,
      );
    }
    const { nPaths, horizonSteps, seed } = grid;
    const nAssets = params.assetIds.length;
    const hist = params.returns;
    const rng = makeRng(seed);

    const prices: number[][][] = Array.from({ length: nAssets }, (_, a) =>
      Array.from({ length: nPaths }, () => {
        const path = new Array<number>(horizonSteps + 1);
        path[0] = params.s0[a];
        return path;
      }),
    );

    for (let p = 0; p < nPaths; p++) {
      let s = 1;
      while (s <= horizonSteps) {
        if (params.mode === "iid") {
          const vec = hist[Math.floor(rng.uniform() * hist.length)];
          for (let a = 0; a < nAssets; a++) {
            prices[a][p][s] = prices[a][p][s - 1] * Math.exp(vec[a]);
          }
          s++;
        } else {
          // Block: contiguous run with wraparound.
          const start = Math.floor(rng.uniform() * hist.length);
          for (let b = 0; b < params.blockLength && s <= horizonSteps; b++, s++) {
            const vec = hist[(start + b) % hist.length];
            for (let a = 0; a < nAssets; a++) {
              prices[a][p][s] = prices[a][p][s - 1] * Math.exp(vec[a]);
            }
          }
        }
      }
    }

    return { assetIds: params.assetIds, nPaths, steps: horizonSteps + 1, prices };
  }
}
