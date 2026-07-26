/**
 * Portfolio Monte-Carlo engine (FR-S1/S3): consumes PricePaths from ANY
 * RiskModel (never a concrete model — that's the AR-5 seam) and values
 * positions with the exact CL token-amount math via @lh/portfolio.
 *
 * Pure aggregation: given the same paths and positions, output is
 * bit-identical (FR-S4).
 */

import { positionValueAtPrice } from "@lh/portfolio";
import { tickToSqrtPriceX64, sqrtPriceX64ToPrice } from "@lh/core/src/market-data/decoder";
import { PricePaths } from "./model";

/** Which component the report's series and statistics are computed on. */
export type Composition = "value" | "value+yield" | "yield";

export interface SimPosition {
  assetId: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  decimalsA: number;
  decimalsB: number;
  /**
   * Fee-yield accrual along each path:
   *   fees_step = rate × V(S_t) × 1{S_t ∈ range} × dt_days
   * `inRangeDailyRate` is the IN-RANGE-CONDITIONAL daily yield on position
   * value (r_pool × concentration, i.e. measuredDailyYield ÷ inRangeFraction)
   * — the in-range indicator is applied here, path-consistently, so do NOT
   * pre-multiply by an in-range fraction.
   * Optional `ratePaths[p][s]` (nPaths × (steps−1), e.g. from the
   * fee-intensity block bootstrap) makes the rate itself stochastic: the
   * rate for the interval ending at step s+1; `inRangeDailyRate` then
   * serves as the documented fallback level for reporting.
   */
  yield?: { inRangeDailyRate: number; ratePaths?: number[][] };
  /**
   * Optional hedge overlay: a Liquidity Hedge certificate held to the
   * simulation horizon. Payoff Π = V(S₀) − V(clamp(S_T, p_l, p_u)) is
   * applied at the terminal step and the premium subtracted upfront.
   * `feeSplitRate` (default 0) deducts the certificate's share of accrued
   * fees in yield-bearing compositions. (v1: no weekly rolling.)
   */
  hedge?: { premiumUsd: number; feeSplitRate?: number };
}

export interface FanSeries {
  p05: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
  mean: number[];
}

export interface TerminalStats {
  mean: number;
  std: number;
  /** 5th percentile of terminal P&L vs initial value. */
  var5: number;
  /** Mean of the worst 5% terminal P&L. */
  cvar5: number;
  pLoss: number;
}

export interface SimulationReport {
  /** Component the fan/terminal/maxDD statistics describe. */
  composition: Composition;
  /** Mean accrued fee income at the horizon (0 when no yield configured). */
  meanAccruedYieldUsd: number;
  initialValue: number;
  /** Portfolio value fan across steps (index 0 = t0). */
  fan: FanSeries;
  terminal: TerminalStats;
  hedgedTerminal: TerminalStats | null;
  maxDrawdown: { mean: number; p50: number; p95: number };
  /** Fraction of paths where any position's price exits its range at any step. */
  pExitRange: number;
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) throw new Error("quantile of empty array");
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function stats(values: number[], initial: number): TerminalStats {
  const pnl = values.map((v) => v - initial).sort((a, b) => a - b);
  const n = pnl.length;
  const mean = pnl.reduce((s, x) => s + x, 0) / n;
  const std = Math.sqrt(
    pnl.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1),
  );
  const var5 = quantile(pnl, 0.05);
  const tail = pnl.slice(0, Math.max(1, Math.floor(n * 0.05)));
  return {
    mean,
    std,
    var5,
    cvar5: tail.reduce((s, x) => s + x, 0) / tail.length,
    pLoss: pnl.filter((x) => x < 0).length / n,
  };
}

export interface SimulateOptions {
  composition?: Composition;
  /** Seconds per path step — REQUIRED when any position configures yield. */
  stepSeconds?: number;
}

export function simulatePortfolio(
  paths: PricePaths,
  positions: SimPosition[],
  opts?: SimulateOptions,
): SimulationReport {
  const composition: Composition = opts?.composition ?? "value";
  const anyYield = positions.some((pos) => pos.yield);
  if ((composition !== "value" || anyYield) && anyYield && !opts?.stepSeconds) {
    throw new Error("simulatePortfolio: stepSeconds required when yield is configured");
  }
  if (composition !== "value" && !anyYield) {
    throw new Error(
      `composition "${composition}" requires at least one position with a yield config`,
    );
  }
  const dtDays = (opts?.stepSeconds ?? 0) / 86_400;
  for (const pos of positions) {
    const rp = pos.yield?.ratePaths;
    if (rp) {
      if (rp.length !== paths.nPaths || rp.some((r) => r.length < paths.steps - 1)) {
        throw new Error(
          `ratePaths must be nPaths×(steps−1) = ${paths.nPaths}×${paths.steps - 1}`,
        );
      }
    }
  }
  if (positions.length === 0) throw new Error("no positions");
  const assetIndex = new Map(paths.assetIds.map((id, i) => [id, i]));
  for (const pos of positions) {
    if (!assetIndex.has(pos.assetId)) {
      throw new Error(`no price paths for asset ${pos.assetId}`);
    }
  }

  // Precompute per-position range prices for exit detection + hedge clamp.
  const meta = positions.map((pos) => {
    const pL = sqrtPriceX64ToPrice(
      tickToSqrtPriceX64(pos.tickLower),
      pos.decimalsA,
      pos.decimalsB,
    );
    const pU = sqrtPriceX64ToPrice(
      tickToSqrtPriceX64(pos.tickUpper),
      pos.decimalsA,
      pos.decimalsB,
    );
    const a = assetIndex.get(pos.assetId)!;
    const s0 = paths.prices[a][0][0];
    return { a, pL, pU, v0: positionValueAtPrice(pos, s0), s0 };
  });

  const initialValue = meta.reduce((s, m) => s + m.v0, 0);
  const { nPaths, steps } = paths;

  const valuesByStep: number[][] = Array.from({ length: steps }, () => []);
  const terminal: number[] = [];
  const hedgedTerminal: number[] = [];
  const maxDDs: number[] = [];
  let exitCount = 0;
  const anyHedge = positions.some((p) => p.hedge);

  let accruedYieldSum = 0;
  for (let p = 0; p < nPaths; p++) {
    let exited = false;
    let peak = -Infinity;
    let maxDD = 0;
    // Per-position accrued fees along THIS path (path-consistent in-range).
    const accrued = new Array<number>(positions.length).fill(0);
    for (let s = 0; s < steps; s++) {
      let value = 0;
      let totalAccrued = 0;
      for (let i = 0; i < positions.length; i++) {
        const price = paths.prices[meta[i].a][p][s];
        const inRange = price >= meta[i].pL && price <= meta[i].pU;
        if (!inRange) exited = true;
        const posValue = positionValueAtPrice(positions[i], price);
        value += posValue;
        // Accrue over the interval ENDING at s, using the interval's start
        // state (price/value at s−1) — mirrors the snapshot integrator.
        const y = positions[i].yield;
        if (y && s > 0) {
          const prevPrice = paths.prices[meta[i].a][p][s - 1];
          if (prevPrice >= meta[i].pL && prevPrice <= meta[i].pU) {
            const rate = y.ratePaths ? y.ratePaths[p][s - 1] : y.inRangeDailyRate;
            accrued[i] +=
              rate * positionValueAtPrice(positions[i], prevPrice) * dtDays;
          }
        }
        totalAccrued += accrued[i];
      }
      const series =
        composition === "value"
          ? value
          : composition === "value+yield"
            ? value + totalAccrued
            : totalAccrued;
      valuesByStep[s].push(series);
      if (series > peak) peak = series;
      else if (peak - series > maxDD) maxDD = peak - series;
      if (s === steps - 1) {
        terminal.push(series);
        accruedYieldSum += totalAccrued;
        if (anyHedge) {
          let hv = series;
          for (let i = 0; i < positions.length; i++) {
            const h = positions[i].hedge;
            if (!h) continue;
            const price = paths.prices[meta[i].a][p][s];
            const clamped = Math.min(Math.max(price, meta[i].pL), meta[i].pU);
            const payoff = meta[i].v0 - positionValueAtPrice(positions[i], clamped);
            const feeSplit = (h.feeSplitRate ?? 0) * accrued[i];
            // Hedge acts on the VALUE component; the fee split reduces the
            // yield component; premium is a cash cost in every composition.
            if (composition === "yield") hv += -feeSplit - h.premiumUsd;
            else hv += payoff - feeSplit - h.premiumUsd;
          }
          hedgedTerminal.push(hv);
        }
      }
    }
    if (exited) exitCount++;
    maxDDs.push(maxDD);
  }

  const fan: FanSeries = { p05: [], p25: [], p50: [], p75: [], p95: [], mean: [] };
  for (const values of valuesByStep) {
    const sorted = [...values].sort((a, b) => a - b);
    fan.p05.push(quantile(sorted, 0.05));
    fan.p25.push(quantile(sorted, 0.25));
    fan.p50.push(quantile(sorted, 0.5));
    fan.p75.push(quantile(sorted, 0.75));
    fan.p95.push(quantile(sorted, 0.95));
    fan.mean.push(values.reduce((s, v) => s + v, 0) / values.length);
  }

  const ddSorted = [...maxDDs].sort((a, b) => a - b);
  const baseline = composition === "yield" ? 0 : initialValue;
  return {
    composition,
    meanAccruedYieldUsd: nPaths > 0 ? accruedYieldSum / nPaths : 0,
    initialValue,
    fan,
    terminal: stats(terminal, baseline),
    hedgedTerminal: anyHedge ? stats(hedgedTerminal, baseline) : null,
    maxDrawdown: {
      mean: maxDDs.reduce((s, v) => s + v, 0) / maxDDs.length,
      p50: quantile(ddSorted, 0.5),
      p95: quantile(ddSorted, 0.95),
    },
    pExitRange: exitCount / nPaths,
  };
}
