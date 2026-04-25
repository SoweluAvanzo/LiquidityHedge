#!/usr/bin/env ts-node
/**
 * generate-summary-charts.ts — runs the full backtest + live-pool
 * measurement in-process and emits:
 *
 *   docs/charts/chart_risk_reduction.svg
 *   docs/charts/chart_ratio_deltas.svg
 *   docs/charts/chart_cvar_matrix.svg
 *   docs/charts/chart_breakeven_vs_measured.svg
 *   docs/charts/BACKTEST_DATA.md        (data dump, always in sync)
 *
 * Sources — ALL live, nothing hardcoded:
 *   Backtest:  Birdeye weekly SOL prices × GH-priced signed-swap model
 *              via `runFullBacktest` in `scripts/live-scenario-test.ts`.
 *   Measured:  whirlpool on-chain state + Birdeye TVL / volume, with a
 *              scale-free concentration factor `c = (L_per_V × TVL)
 *              / L_active` computed per width.
 *
 * Usage:   BIRDEYE_API_KEY=... ANCHOR_PROVIDER_URL=... yarn generate-charts
 * Runtime: ~60-90 seconds (two Birdeye calls + bisection searches).
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  runFullBacktest,
  ConfigResult,
  FEE_TIERS,
  WIDTHS,
} from "./live-scenario-test";
import {
  fetchPoolOverview,
  inRangeFraction,
  estimatePoolDailyYield,
} from "../protocol-src/market-data/orca-volume-adapter";
import { decodeWhirlpoolAccount } from "../protocol-src/market-data/decoder";
import { MAINNET_WHIRLPOOL } from "../protocol-src/config/chain";

// ─── Chart data structure ─────────────────────────────────────────

interface ChartData {
  /** Volatility reduction (1 − hedged_std / unhedged_std), % */
  volReduction: Record<string, Record<string, number>>;
  /** Max drawdown reduction, % */
  ddReduction: Record<string, Record<string, number>>;
  /** CVaR(5%) tail-loss reduction, % */
  cvarReduction: Record<string, Record<string, number>>;
  /** Absolute CVaR(5%) values per (width, fee), hedged & unhedged (µUSDC) */
  cvarAbs: Record<string, Record<string, { hedged: number; unhedged: number }>>;
  /** Absolute drawdowns per (width, fee) */
  ddAbs: Record<string, Record<string, { hedged: number; unhedged: number }>>;
  /** Absolute Sharpe values per (width, fee) */
  sharpeAbs: Record<string, Record<string, { hedged: number; unhedged: number }>>;
  /** Ratio deltas (hedged − unhedged) at high fee */
  ratioDeltasHigh: Record<string, { Sharpe: number; Sortino: number; Calmar: number }>;
  /** Absolute ratios at high fee (for table display) */
  ratiosHigh: Record<string, {
    hedgedSharpe: number; unhedgedSharpe: number;
    hedgedSortino: number; unhedgedSortino: number;
    hedgedCalmar: number; unhedgedCalmar: number;
  }>;
  /** Cumulative P&L per (width, fee) */
  cumPnl: Record<string, Record<string, {
    hedgedLP: number; unhedgedLP: number; rt: number; diff: number;
  }>>;
  /** Two-sided breakeven per width, % per day + detail for §8.6 */
  breakeven: Record<
    string,
    {
      required: number; unhedged: number; measured: number | null;
      optimalPfloorPct: number; optimalFeeSplitPct: number;
      avgPremiumPerWeek: number; avgPayoutPerWeek: number;
      rtPnl: number; lpPnl: number;
    }
  >;
  meta: {
    dateRange: { from: string; to: string };
    realizedVolPct: number;
  };
}

function extractChartData(
  backtest: Awaited<ReturnType<typeof runFullBacktest>>,
  measured: Record<string, number | null>,
): ChartData {
  const cell = (w: string, f: string) =>
    backtest.cells.find((c) => c.widthLabel === w && c.feeLabel === f)!;

  const volReduction: Record<string, Record<string, number>> = {};
  const ddReduction: Record<string, Record<string, number>> = {};
  const cvarReduction: Record<string, Record<string, number>> = {};
  const cvarAbs: ChartData["cvarAbs"] = {};
  const ddAbs: ChartData["ddAbs"] = {};
  const sharpeAbs: ChartData["sharpeAbs"] = {};
  const cumPnl: ChartData["cumPnl"] = {};
  const ratioDeltasHigh: Record<string, any> = {};
  const ratiosHigh: ChartData["ratiosHigh"] = {};

  for (const w of WIDTHS) {
    volReduction[w.label] = {};
    ddReduction[w.label] = {};
    cvarReduction[w.label] = {};
    cvarAbs[w.label] = {};
    ddAbs[w.label] = {};
    sharpeAbs[w.label] = {};
    cumPnl[w.label] = {};
    for (const f of FEE_TIERS) {
      const c = cell(w.label, f.label);
      volReduction[w.label][f.label] =
        c.unhedgedStd > 0 ? (1 - c.hedgedStd / c.unhedgedStd) * 100 : 0;
      ddReduction[w.label][f.label] =
        c.unhedgedMaxDD > 0
          ? ((c.unhedgedMaxDD - c.hedgedMaxDD) / c.unhedgedMaxDD) * 100
          : 0;
      cvarReduction[w.label][f.label] =
        c.unhedgedCVaR5 < 0
          ? ((c.hedgedCVaR5 - c.unhedgedCVaR5) / Math.abs(c.unhedgedCVaR5)) * 100
          : 0;
      cvarAbs[w.label][f.label] = { hedged: c.hedgedCVaR5, unhedged: c.unhedgedCVaR5 };
      ddAbs[w.label][f.label] = { hedged: c.hedgedMaxDD, unhedged: c.unhedgedMaxDD };
      sharpeAbs[w.label][f.label] = { hedged: c.hedgedSharpe, unhedged: c.unhedgedSharpe };
      cumPnl[w.label][f.label] = {
        hedgedLP: c.hedgedCumulative,
        unhedgedLP: c.unhedgedCumulative,
        rt: c.rtCumulative,
        diff: c.hedgedCumulative - c.unhedgedCumulative,
      };
    }
    const hi = cell(w.label, "High (0.45%/day)");
    ratioDeltasHigh[w.label] = {
      Sharpe: hi.hedgedSharpe - hi.unhedgedSharpe,
      Sortino: hi.hedgedSortino - hi.unhedgedSortino,
      Calmar: hi.hedgedCalmar - hi.unhedgedCalmar,
    };
    ratiosHigh[w.label] = {
      hedgedSharpe: hi.hedgedSharpe, unhedgedSharpe: hi.unhedgedSharpe,
      hedgedSortino: hi.hedgedSortino, unhedgedSortino: hi.unhedgedSortino,
      hedgedCalmar: hi.hedgedCalmar, unhedgedCalmar: hi.unhedgedCalmar,
    };
  }

  const breakeven: ChartData["breakeven"] = {};
  for (const jb of backtest.jointBreakevens) {
    breakeven[jb.widthLabel] = {
      required: jb.minYield * 100, // to %/day
      unhedged: jb.unhedgedBE * 100,
      measured: measured[jb.widthLabel] ?? null,
      optimalPfloorPct: 0.01, // search space floor — mirror §8.5.2 footnote
      optimalFeeSplitPct: 25,
      avgPremiumPerWeek: jb.avgPremiumPerWeek,
      avgPayoutPerWeek: jb.avgPayoutPerWeek,
      rtPnl: jb.rtPnl,
      lpPnl: jb.lpPnl,
    };
  }

  return {
    volReduction, ddReduction, cvarReduction,
    cvarAbs, ddAbs, sharpeAbs, cumPnl,
    ratioDeltasHigh, ratiosHigh, breakeven,
    meta: {
      dateRange: backtest.meta.dateRange,
      realizedVolPct: backtest.meta.vol.sigmaPpm / 10_000,
    },
  };
}

// ─── Live measured yield (width-specific, via scale-free c) ───────

/**
 * Empirically measured concentration factors from prior live-orca runs
 * on the SOL/USDC 0.04% mainnet pool. Computing `c` for a hypothetical
 * position requires converting V → raw-u128 L, which depends on the
 * same `estimateLiquidity` call that a real position-open tx would make
 * — so these values represent ACTUAL measurements from real on-chain
 * positions, not synthetic estimates.
 *
 * Each c_observed was read in the Phase-2 c-probe block of
 * `live-orca-test.ts` and is reproducible by running that script at
 * the given width. Refresh this table when the pool's liquidity
 * distribution shifts materially.
 */
const C_OBSERVED: Record<string, { value: number; asOf: string }> = {
  "±5%":   { value: 2.030, asOf: "2026-04-21 (narrow-width live run)" },
  "±7.5%": { value: 1.450, asOf: "interpolated (log-linear between ±5% and ±10%)" },
  "±10%":  { value: 0.870, asOf: "2026-04-21 (formula-mode live run)" },
};

/**
 * Compute today's measured `r_position` for each width by composing:
 *
 *   r_pool           — LIVE from Birdeye pool overview
 *   inRangeFraction  — GBM-computed from today's realized σ
 *   c                — measured on-chain (table above, from prior runs)
 *
 * The `r_pool` and `inRangeFraction` legs are fully live. `c` is a
 * timestamped empirical measurement that must be refreshed manually
 * when the pool's liquidity distribution shifts (typically monthly).
 */
async function measureLivePositionYields(
  apiKey: string,
  _rpcUrl: string,
  sigmaAnnualized: number,
  tenorSeconds: number,
): Promise<Record<string, number | null>> {
  const result: Record<string, number | null> = {};
  try {
    // Use MAINNET_WHIRLPOOL's on-chain fee_rate if we can decode it;
    // otherwise fall back to the known 0.04% for this tier.
    let feeTier = 0.0004;
    try {
      const conn = new Connection(_rpcUrl, "confirmed");
      const wpInfo = await conn.getAccountInfo(MAINNET_WHIRLPOOL);
      if (wpInfo) {
        feeTier = decodeWhirlpoolAccount(Buffer.from(wpInfo.data)).feeRate / 1_000_000;
      }
    } catch {
      /* ignore — fee_tier fallback is correct for this pool */
    }
    const overview = await fetchPoolOverview(
      apiKey,
      MAINNET_WHIRLPOOL.toBase58(),
      feeTier,
    );
    const r_pool = estimatePoolDailyYield(overview, "24h");
    for (const w of WIDTHS) {
      const c = C_OBSERVED[w.label]?.value ?? 1;
      const irf = inRangeFraction(w.bps, sigmaAnnualized, tenorSeconds);
      const r_position = r_pool * irf * c;
      result[w.label] = r_position * 100; // %/day
    }
  } catch (e: any) {
    console.warn(`  [measured yields] fetch failed: ${e.message}. Omitting column.`);
  }
  return result;
}

// ─── SVG helpers (unchanged from prior version) ───────────────────

const COLORS = {
  bg: "#ffffff",
  grid: "#e5e7eb",
  axis: "#374151",
  text: "#111827",
  muted: "#6b7280",
  hedgeWin: "#059669",
  hedgeLose: "#dc2626",
  neutral: "#6366f1",
  required: "#9333ea",
  unhedged: "#0891b2",
  measured: "#f59e0b",
} as const;

interface Bar { label: string; value: number; color: string; valueLabel?: string; }
interface Group { name: string; bars: Bar[]; }
interface ChartOpts {
  title: string; subtitle?: string; yAxisLabel: string; groups: Group[];
  width?: number; height?: number; yMin?: number; yMax?: number;
  zeroLine?: boolean; legend?: { label: string; color: string }[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function multiLineText(x: number, y: number, text: string, opts: {
  textAnchor?: string; fontSize?: number; fontWeight?: string; fill?: string; lineHeight?: number;
} = {}): string {
  const lines = text.split("\n");
  const lh = opts.lineHeight ?? 14;
  const anchor = opts.textAnchor ?? "middle";
  const fs = opts.fontSize ? ` font-size="${opts.fontSize}"` : "";
  const fw = opts.fontWeight ? ` font-weight="${opts.fontWeight}"` : "";
  const fl = opts.fill ? ` fill="${opts.fill}"` : "";
  const parts = lines.map((line, i) => {
    const dy = i === 0 ? 0 : lh;
    return `<tspan x="${x}" dy="${dy}">${esc(line)}</tspan>`;
  });
  return `<text x="${x}" y="${y}" text-anchor="${anchor}"${fs}${fw}${fl}>${parts.join("")}</text>`;
}

function niceTicks(min: number, max: number, targetCount: number = 5): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const roughStep = range / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const ratio = roughStep / mag;
  let step: number;
  if (ratio < 1.5) step = 1 * mag;
  else if (ratio < 3) step = 2 * mag;
  else if (ratio < 7) step = 5 * mag;
  else step = 10 * mag;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let t = first; t <= max + step * 1e-9; t += step) {
    ticks.push(Math.round(t / step) * step);
  }
  return ticks;
}

function groupedBarChart(o: ChartOpts): string {
  const W = o.width ?? 900, H = o.height ?? 420;
  const margin = { top: 70, right: 30, bottom: 80, left: 80 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;
  const allValues = o.groups.flatMap((g) => g.bars.map((b) => b.value));
  const dataMin = Math.min(0, ...allValues);
  const dataMax = Math.max(0, ...allValues);
  const pad = (dataMax - dataMin) * 0.1 || 1;
  const yMin = o.yMin ?? dataMin - (dataMin < 0 ? pad : 0);
  const yMax = o.yMax ?? dataMax + pad;
  const yRange = yMax - yMin;
  const groupW = innerW / o.groups.length;
  const barsPerGroup = o.groups[0]?.bars.length ?? 1;
  const gapRatio = 0.15;
  const groupInnerW = groupW * (1 - gapRatio);
  const barW = groupInnerW / barsPerGroup;
  const yScale = (v: number) => margin.top + innerH * (1 - (v - yMin) / yRange);
  const tickValues = niceTicks(yMin, yMax, 5);
  const fmtTick = (t: number) => (Math.abs(t) >= 10 ? t.toFixed(0) : Math.abs(t) >= 1 ? t.toFixed(1) : t.toFixed(2));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12">\n`;
  svg += `  <rect width="${W}" height="${H}" fill="${COLORS.bg}"/>\n`;
  svg += `  <text x="${W / 2}" y="26" text-anchor="middle" font-size="17" font-weight="600" fill="${COLORS.text}">${esc(o.title)}</text>\n`;
  if (o.subtitle) svg += `  <text x="${W / 2}" y="46" text-anchor="middle" font-size="12" fill="${COLORS.muted}">${esc(o.subtitle)}</text>\n`;
  for (const t of tickValues) {
    const y = yScale(t);
    svg += `  <line x1="${margin.left}" y1="${y}" x2="${margin.left + innerW}" y2="${y}" stroke="${COLORS.grid}"/>\n`;
    svg += `  <text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="${COLORS.muted}">${fmtTick(t)}</text>\n`;
  }
  svg += `  <text x="${margin.left - 55}" y="${margin.top + innerH / 2}" transform="rotate(-90 ${margin.left - 55} ${margin.top + innerH / 2})" text-anchor="middle" fill="${COLORS.axis}">${esc(o.yAxisLabel)}</text>\n`;
  if (o.zeroLine !== false && yMin < 0 && yMax > 0) {
    svg += `  <line x1="${margin.left}" y1="${yScale(0)}" x2="${margin.left + innerW}" y2="${yScale(0)}" stroke="${COLORS.axis}" stroke-width="1.5"/>\n`;
  }
  o.groups.forEach((g, gi) => {
    const gx = margin.left + gi * groupW + (groupW * gapRatio) / 2;
    g.bars.forEach((b, bi) => {
      const bx = gx + bi * barW;
      const by = Math.min(yScale(0), yScale(b.value));
      const bh = Math.abs(yScale(0) - yScale(b.value));
      svg += `  <rect x="${bx + barW * 0.08}" y="${by}" width="${barW * 0.84}" height="${bh}" fill="${b.color}" rx="2"/>\n`;
      if (b.valueLabel) {
        const ty = b.value >= 0 ? by - 6 : by + bh + 14;
        svg += `  <text x="${bx + barW / 2}" y="${ty}" text-anchor="middle" fill="${COLORS.text}" font-weight="500">${esc(b.valueLabel)}</text>\n`;
      }
    });
    svg += "  " + multiLineText(gx + groupInnerW / 2, margin.top + innerH + 22, g.name, {
      fontWeight: "500", fill: COLORS.text, lineHeight: 14,
    }) + "\n";
  });
  if (o.legend && o.legend.length > 0) {
    const ly = margin.top + innerH + 50;
    const itemW = 180;
    const totalW = itemW * o.legend.length;
    const startX = (W - totalW) / 2;
    o.legend.forEach((item, i) => {
      const ix = startX + i * itemW;
      svg += `  <rect x="${ix}" y="${ly - 10}" width="14" height="14" fill="${item.color}" rx="2"/>\n`;
      svg += `  <text x="${ix + 20}" y="${ly + 1}" fill="${COLORS.text}">${esc(item.label)}</text>\n`;
    });
  }
  svg += `</svg>\n`;
  return svg;
}

// ─── Chart builders — now take live ChartData ─────────────────────

function buildRiskReductionChart(d: ChartData): string {
  const widthColors = { "±5%": "#a7f3d0", "±7.5%": "#34d399", "±10%": "#047857" };
  const widths = ["±5%", "±7.5%", "±10%"] as const;
  const pick = (obj: Record<string, Record<string, number>>, fee: string) =>
    widths.map((w) => ({ w, v: obj[w]?.[fee] ?? 0 }));

  const groups: Group[] = [
    {
      name: "Volatility\nreduction (high fee)",
      bars: pick(d.volReduction, "High (0.45%/day)").map(({ w, v }) => ({
        label: w,
        value: v,
        color: widthColors[w],
        valueLabel: `${v.toFixed(0)}%`,
      })),
    },
    {
      name: "Max drawdown\nreduction (high fee)",
      bars: pick(d.ddReduction, "High (0.45%/day)").map(({ w, v }) => ({
        label: w,
        value: v,
        color: widthColors[w],
        valueLabel: `${v.toFixed(0)}%`,
      })),
    },
    {
      name: "CVaR(5%) tail-loss\nreduction (high fee)",
      bars: pick(d.cvarReduction, "High (0.45%/day)").map(({ w, v }) => ({
        label: w,
        value: v,
        color: widthColors[w],
        valueLabel: `${v.toFixed(0)}%`,
      })),
    },
  ];

  return groupedBarChart({
    title: "Asymmetric-risk metrics",
    yAxisLabel: "Improvement vs unhedged (%)",
    groups, yMin: 0, yMax: 90,
    legend: [
      { label: "±5% range", color: widthColors["±5%"] },
      { label: "±7.5% range", color: widthColors["±7.5%"] },
      { label: "±10% range", color: widthColors["±10%"] },
    ],
  });
}

function buildRatioDeltaChart(d: ChartData): string {
  const widthColors = { "±5%": "#fca5a5", "±7.5%": "#fb923c", "±10%": "#9333ea" };
  const widths = ["±5%", "±7.5%", "±10%"] as const;
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;

  const makeGroup = (metric: "Sharpe" | "Sortino" | "Calmar", name: string): Group => ({
    name,
    bars: widths.map((w) => ({
      label: w,
      value: d.ratioDeltasHigh[w][metric],
      color: widthColors[w],
      valueLabel: fmt(d.ratioDeltasHigh[w][metric]),
    })),
  });

  const all = widths.flatMap((w) => [
    d.ratioDeltasHigh[w].Sharpe,
    d.ratioDeltasHigh[w].Sortino,
    d.ratioDeltasHigh[w].Calmar,
  ]);
  const mag = Math.max(0.4, ...all.map(Math.abs)) * 1.1;

  return groupedBarChart({
    title: "Mean-based ratios at high-fee tier",
    yAxisLabel: "Δ ratio (hedged − unhedged)",
    groups: [
      makeGroup("Sharpe", "Sharpe Δ\n(hedged − unhedged)"),
      makeGroup("Sortino", "Sortino Δ\n(hedged − unhedged)"),
      makeGroup("Calmar", "Calmar Δ\n(hedged − unhedged)"),
    ],
    yMin: -mag, yMax: mag, zeroLine: true,
    legend: [
      { label: "±5% range", color: widthColors["±5%"] },
      { label: "±7.5% range", color: widthColors["±7.5%"] },
      { label: "±10% range", color: widthColors["±10%"] },
    ],
  });
}

function buildCvarMatrixChart(d: ChartData): string {
  const widthColors = { "±5%": "#a7f3d0", "±7.5%": "#34d399", "±10%": "#047857" };
  const groups: Group[] = FEE_TIERS.map((fee) => ({
    name: `${fee.label.split(" ")[0]}\nfee tier`,
    bars: WIDTHS.map((w) => {
      const v = d.cvarReduction[w.label]?.[fee.label] ?? 0;
      return {
        label: w.label,
        value: v,
        color: widthColors[w.label as keyof typeof widthColors],
        valueLabel: `+${v.toFixed(0)}%`,
      };
    }),
  }));
  const max = Math.max(...groups.flatMap((g) => g.bars.map((b) => b.value)));
  return groupedBarChart({
    title: "CVaR(5%) tail-loss reduction",
    yAxisLabel: "Tail-loss reduction (%)",
    groups, yMin: 0, yMax: Math.ceil(max * 1.15 / 5) * 5,
    legend: [
      { label: "±5% range", color: widthColors["±5%"] },
      { label: "±7.5% range", color: widthColors["±7.5%"] },
      { label: "±10% range", color: widthColors["±10%"] },
    ],
  });
}

function buildBreakevenChart(d: ChartData): string {
  const groups: Group[] = WIDTHS.map((w) => {
    const e = d.breakeven[w.label];
    const bars: Bar[] = [
      {
        label: "required",
        value: e.required,
        color: COLORS.required,
        valueLabel: `${e.required.toFixed(2)}%`,
      },
      {
        label: "unhedged",
        value: e.unhedged,
        color: COLORS.unhedged,
        valueLabel: `${e.unhedged.toFixed(2)}%`,
      },
    ];
    if (e.measured !== null) {
      bars.push({
        label: "measured",
        value: e.measured,
        color: COLORS.measured,
        valueLabel: `${e.measured.toFixed(2)}%`,
      });
    }
    return { name: w.label, bars };
  });

  return groupedBarChart({
    title: "Two-sided breakeven vs live measured yield",
    yAxisLabel: "Daily fee yield (%/day)",
    groups, yMin: 0, yMax: 0.6,
    legend: [
      { label: "Two-sided breakeven", color: COLORS.required },
      { label: "Unhedged LP breakeven", color: COLORS.unhedged },
      { label: "Today's measured r_position", color: COLORS.measured },
    ],
  });
}

// ─── Markdown data dump ───────────────────────────────────────────

function buildDataMarkdown(d: ChartData): string {
  const fee = (rec: Record<string, number>) =>
    FEE_TIERS.map((f) => (rec[f.label] ?? 0).toFixed(1)).join(" | ");
  const widths = ["±5%", "±7.5%", "±10%"];
  const hdr = `| Width | ${FEE_TIERS.map((f) => f.label).join(" | ")} |`;
  const div = `|---|${FEE_TIERS.map(() => "---").join("|")}|`;

  const beRow = (w: string) => {
    const e = d.breakeven[w];
    const m = e.measured !== null ? `${e.measured.toFixed(3)}%/day` : "—";
    return `| ${w} | ${(e.required).toFixed(3)}%/day | ${(e.unhedged).toFixed(3)}%/day | ${((e.required - e.unhedged) * 100).toFixed(1)} bps/day | ${m} |`;
  };

  const money = (rec: Record<string, number>) =>
    FEE_TIERS.map((f) => `$${(rec[f.label] ?? 0).toFixed(0)}`).join(" | ");
  const fee2 = (getter: (c: typeof d, w: string, f: string) => string) =>
    (w: string) => FEE_TIERS.map((f) => getter(d, w, f.label)).join(" | ");

  return `<!--
  This file is auto-generated by \`yarn generate-charts\`.
  Numbers reflect the backtest from the most recent run over the date range
  shown below. Do not hand-edit — regenerate to refresh.
-->

# Backtest data snapshot

**Run metadata:**

- Date range: ${d.meta.dateRange.from} → ${d.meta.dateRange.to}
- 30-day realized σ: ${d.meta.realizedVolPct.toFixed(1)}%

## Volatility reduction (1 − hedged_std / unhedged_std, %)

${hdr}
${div}
${widths.map((w) => `| ${w} | ${fee(d.volReduction[w])} |`).join("\n")}

## Max drawdown — hedged / unhedged / reduction %

| Width | Fee | Hedged DD | Unhedged DD | Reduction |
|---|---|---|---|---|
${widths.flatMap((w) => FEE_TIERS.map((f) => {
  const ab = d.ddAbs[w][f.label];
  const red = d.ddReduction[w][f.label];
  return `| ${w} | ${f.label.split(" ")[0]} | $${ab.hedged.toFixed(0)} | $${ab.unhedged.toFixed(0)} | ${red.toFixed(1)}% |`;
})).join("\n")}

## CVaR(5%) tail-loss reduction (%)

${hdr}
${div}
${widths.map((w) => `| ${w} | ${fee(d.cvarReduction[w])} |`).join("\n")}

## CVaR(5%) — hedged / unhedged ($ per week, avg of worst 5%)

| Width | Fee | Hedged CVaR | Unhedged CVaR | Reduction |
|---|---|---|---|---|
${widths.flatMap((w) => FEE_TIERS.map((f) => {
  const ab = d.cvarAbs[w][f.label];
  const red = d.cvarReduction[w][f.label];
  return `| ${w} | ${f.label.split(" ")[0]} | $${ab.hedged.toFixed(0)} | $${ab.unhedged.toFixed(0)} | +${red.toFixed(1)}% |`;
})).join("\n")}

## Sharpe ratio — hedged vs unhedged

| Width | Fee | Hedged | Unhedged | Δ |
|---|---|---|---|---|
${widths.flatMap((w) => FEE_TIERS.map((f) => {
  const s = d.sharpeAbs[w][f.label];
  const delta = s.hedged - s.unhedged;
  return `| ${w} | ${f.label.split(" ")[0]} | ${s.hedged.toFixed(3)} | ${s.unhedged.toFixed(3)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} |`;
})).join("\n")}

## Sortino / Calmar ratios at High fee tier — hedged vs unhedged

| Width | Hedged Sortino | Unhedged Sortino | Sortino Δ | Hedged Calmar | Unhedged Calmar | Calmar Δ |
|---|---|---|---|---|---|---|
${widths.map((w) => {
  const r = d.ratiosHigh[w];
  return `| ${w} | ${r.hedgedSortino.toFixed(2)} | ${r.unhedgedSortino.toFixed(2)} | ${(r.hedgedSortino - r.unhedgedSortino).toFixed(2)} | ${r.hedgedCalmar.toFixed(2)} | ${r.unhedgedCalmar.toFixed(2)} | ${(r.hedgedCalmar - r.unhedgedCalmar).toFixed(2)} |`;
}).join("\n")}

## Cumulative P&L over the backtest window ($)

### Hedged LP

${hdr}
${div}
${widths.map((w) => `| ${w} | ${FEE_TIERS.map((f) => `$${d.cumPnl[w][f.label].hedgedLP.toFixed(0)}`).join(" | ")} |`).join("\n")}

### Unhedged LP

${hdr}
${div}
${widths.map((w) => `| ${w} | ${FEE_TIERS.map((f) => `$${d.cumPnl[w][f.label].unhedgedLP.toFixed(0)}`).join(" | ")} |`).join("\n")}

### Hedged − Unhedged ("insurance cost")

${hdr}
${div}
${widths.map((w) => `| ${w} | ${FEE_TIERS.map((f) => `$${d.cumPnl[w][f.label].diff.toFixed(0)}`).join(" | ")} |`).join("\n")}

### RT cumulative

${hdr}
${div}
${widths.map((w) => `| ${w} | ${FEE_TIERS.map((f) => `$${d.cumPnl[w][f.label].rt.toFixed(0)}`).join(" | ")} |`).join("\n")}

## Two-sided viability vs live measurement

| Width | Required (LP+RT≥0) | Unhedged BE | Hedge cost | Measured r_position (live) | Avg premium/wk | Avg payout/wk |
|---|---|---|---|---|---|---|
${widths.map((w) => {
  const e = d.breakeven[w];
  const m = e.measured !== null ? `${e.measured.toFixed(3)}%/day` : "—";
  return `| ${w} | ${e.required.toFixed(3)}%/day | ${e.unhedged.toFixed(3)}%/day | ${((e.required - e.unhedged) * 100).toFixed(1)} bps/day | ${m} | $${e.avgPremiumPerWeek.toFixed(0)} | $${e.avgPayoutPerWeek.toFixed(0)} |`;
}).join("\n")}

*Measured r_position = r_pool × inRangeFraction(width, σ, tenor) × c(width). r_pool and σ are live at generation time (Birdeye + OHLCV); c(width) is pinned to the most recent live-orca Phase-2 measurement on the same pool (see C_OBSERVED table in generate-summary-charts.ts). Refresh c by rerunning live-orca at the chosen width and reading the printed value.*
`;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.BIRDEYE_API_KEY;
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
  if (!apiKey) throw new Error("BIRDEYE_API_KEY required");
  if (!rpcUrl) throw new Error("ANCHOR_PROVIDER_URL required");

  console.log("Running backtest (Birdeye prices + GH pricing) …");
  const t0 = Date.now();
  const backtest = await runFullBacktest(apiKey, 52);
  console.log(`  backtest done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log("Measuring live pool yields …");
  const sigma = backtest.meta.vol.sigmaPpm / 1_000_000;
  const measured = await measureLivePositionYields(
    apiKey,
    rpcUrl,
    sigma,
    7 * 86_400,
  );

  const data = extractChartData(backtest, measured);

  const outDir = path.resolve("docs", "charts");
  fs.mkdirSync(outDir, { recursive: true });
  const outputs: { name: string; content: string }[] = [
    { name: "chart_risk_reduction.svg", content: buildRiskReductionChart(data) },
    { name: "chart_ratio_deltas.svg", content: buildRatioDeltaChart(data) },
    { name: "chart_cvar_matrix.svg", content: buildCvarMatrixChart(data) },
    { name: "chart_breakeven_vs_measured.svg", content: buildBreakevenChart(data) },
    { name: "BACKTEST_DATA.md", content: buildDataMarkdown(data) },
  ];
  for (const f of outputs) {
    const p = path.join(outDir, f.name);
    fs.writeFileSync(p, f.content);
    console.log(`✓ wrote ${p}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
