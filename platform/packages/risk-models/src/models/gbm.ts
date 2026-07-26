/**
 * Multi-asset GBM with correlated shocks — the same model class the
 * pricing engine's quadrature assumes, so simulation and quoting stay
 * consistent (AR-5).
 */

import {
  AssetSeries,
  PricePaths,
  RiskModel,
  RiskModelDescriptor,
  SimulationGrid,
  SECONDS_PER_YEAR,
  jointLogReturns,
  lastCloses,
} from "../model";
import { makeRng } from "../rng";

export type DriftMode = "zero" | "historical" | "custom";

export interface GbmConfig {
  driftMode: DriftMode;
  /** Annualized drift per asset, used only when driftMode = "custom". */
  customDrift?: number[];
  /** Annualized vol override per asset (else calibrated from history). */
  sigmaOverride?: number[];
}

export interface GbmParams {
  assetIds: string[];
  s0: number[];
  /** Annualized. */
  sigma: number[];
  /** Annualized arithmetic drift μ (log-drift is μ − σ²/2). */
  mu: number[];
  /** Lower-triangular Cholesky factor of the return correlation matrix. */
  chol: number[][];
}

function correlationMatrix(returns: number[][], nAssets: number): number[][] {
  const n = returns.length;
  const mean = Array(nAssets).fill(0);
  for (const vec of returns) vec.forEach((r, a) => (mean[a] += r / n));
  const cov = Array.from({ length: nAssets }, () => Array(nAssets).fill(0));
  for (const vec of returns) {
    for (let a = 0; a < nAssets; a++) {
      for (let b = 0; b < nAssets; b++) {
        cov[a][b] += ((vec[a] - mean[a]) * (vec[b] - mean[b])) / (n - 1);
      }
    }
  }
  const corr = Array.from({ length: nAssets }, () => Array(nAssets).fill(0));
  for (let a = 0; a < nAssets; a++) {
    for (let b = 0; b < nAssets; b++) {
      const denom = Math.sqrt(cov[a][a] * cov[b][b]);
      corr[a][b] = denom > 0 ? cov[a][b] / denom : a === b ? 1 : 0;
    }
  }
  return corr;
}

/** Cholesky with diagonal jitter for near-PSD sample matrices. */
export function cholesky(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row) => [...row]);
  for (let i = 0; i < n; i++) a[i][i] += 1e-10;
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error("correlation matrix not positive definite");
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

export class GbmModel implements RiskModel<GbmParams, GbmConfig> {
  describe(): RiskModelDescriptor {
    return {
      id: "gbm",
      version: "1.0.0",
      label: "Geometric Brownian Motion (correlated)",
      configSchema: {
        type: "object",
        properties: {
          driftMode: {
            type: "string",
            enum: ["zero", "historical", "custom"],
            default: "zero",
            description:
              "zero = risk-neutral (matches pricing); historical = sample mean; custom = user-provided",
          },
          customDrift: {
            type: "array",
            items: { type: "number" },
            description: "Annualized drift per asset (driftMode=custom)",
          },
          sigmaOverride: {
            type: "array",
            items: { type: "number", exclusiveMinimum: 0 },
            description:
              "Annualized volatility as a decimal: 0.69 = 69%/year ≈ ±9.6% in a typical week (σ/√52). Guide: calm crypto ≈ 0.4–0.5, typical SOL ≈ 0.6–0.8, stressed > 1.0. Leave empty to calibrate from history.",
          },
        },
        required: ["driftMode"],
        additionalProperties: false,
      },
    };
  }

  calibrate(history: AssetSeries[], config: GbmConfig): GbmParams {
    const returns = jointLogReturns(history);
    const nAssets = history.length;
    const stepYears = history[0].stepSeconds / SECONDS_PER_YEAR;

    const sigma: number[] = [];
    const mu: number[] = [];
    for (let a = 0; a < nAssets; a++) {
      const rs = returns.map((v) => v[a]);
      const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
      const variance =
        rs.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rs.length - 1);
      const sig = config.sigmaOverride?.[a] ?? Math.sqrt(variance / stepYears);
      sigma.push(sig);
      switch (config.driftMode) {
        case "zero":
          mu.push(0);
          break;
        case "historical":
          // arithmetic drift from mean log return: μ = m/Δt + σ²/2
          mu.push(mean / stepYears + (sig * sig) / 2);
          break;
        case "custom":
          if (config.customDrift?.[a] === undefined) {
            throw new Error(`customDrift[${a}] required for driftMode=custom`);
          }
          mu.push(config.customDrift[a]);
          break;
      }
    }

    return {
      assetIds: history.map((h) => h.assetId),
      s0: lastCloses(history),
      sigma,
      mu,
      chol: cholesky(correlationMatrix(returns, nAssets)),
    };
  }

  simulatePaths(params: GbmParams, grid: SimulationGrid): PricePaths {
    const { nPaths, horizonSteps, stepSeconds, seed } = grid;
    const nAssets = params.assetIds.length;
    const dt = stepSeconds / SECONDS_PER_YEAR;
    const rng = makeRng(seed);

    const prices: number[][][] = Array.from({ length: nAssets }, (_, a) =>
      Array.from({ length: nPaths }, () => {
        const path = new Array<number>(horizonSteps + 1);
        path[0] = params.s0[a];
        return path;
      }),
    );

    const z = new Array<number>(nAssets);
    const eps = new Array<number>(nAssets);
    for (let p = 0; p < nPaths; p++) {
      for (let s = 1; s <= horizonSteps; s++) {
        for (let a = 0; a < nAssets; a++) z[a] = rng.gaussian();
        for (let a = 0; a < nAssets; a++) {
          let e = 0;
          for (let k = 0; k <= a; k++) e += params.chol[a][k] * z[k];
          eps[a] = e;
        }
        for (let a = 0; a < nAssets; a++) {
          const sig = params.sigma[a];
          const logStep =
            (params.mu[a] - (sig * sig) / 2) * dt + sig * Math.sqrt(dt) * eps[a];
          prices[a][p][s] = prices[a][p][s - 1] * Math.exp(logStep);
        }
      }
    }

    return { assetIds: params.assetIds, nPaths, steps: horizonSteps + 1, prices };
  }
}
