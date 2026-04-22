/**
 * Live Scenario Test — Multi-Width, Multi-Yield Historical Backtest
 *
 * Fetches real weekly SOL/USDC closing prices from the Birdeye API
 * and runs the Liquidity Hedge across a matrix of:
 *   - Position widths: ±5%, ±7.5%, ±10%
 *   - Daily fee yield tiers: low (0.10%), medium (0.25%), high (0.45%)
 *
 * Additionally computes the **breakeven daily fee rate** for each width:
 * the yield at which the hedged LP and unhedged LP strategies produce
 * zero cumulative PnL over the backtest period.
 *
 * Limitations:
 *   - LP fees are simulated because Birdeye does not provide
 *     per-position fee data.
 *
 * Usage:
 *   BIRDEYE_API_KEY=<key> npx ts-node scripts/live-scenario-test.ts
 *   (or place the key in a .env file)
 */

import "dotenv/config";

import {
  OffchainLhProtocol,
} from "../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
} from "../protocol-src/config/templates";
import {
  TemplateConfig,
} from "../protocol-src/types";
import {
  clPositionValue,
  naturalCap,
} from "../protocol-src/pricing-engine/position-value";
import {
  fetchWeeklyPrices,
  fetchOHLCV,
  computeVolatility,
  OHLCVCandle,
  VolatilityResult,
} from "../protocol-src/market-data/birdeye-adapter";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const L = 10_000;
const RT_DEPOSIT = 5_000_000_000_000; // $5,000,000 micro-USDC (enough for ~$880 cap at 30% util)
const MIN_WEEKS = 8;
/** P_floor as a fraction of position value (1% = 0.01) */
const PFLOOR_FRACTION = 0.01;

/** Position widths to test */
const WIDTHS = [
  { label: "±5%",   bps: 500 },
  { label: "±7.5%", bps: 750 },
  { label: "±10%",  bps: 1000 },
];

/** Daily fee yield tiers */
const FEE_TIERS = [
  { label: "Low (0.10%/day)",    rate: 0.001 },
  { label: "Medium (0.25%/day)", rate: 0.0025 },
  { label: "High (0.45%/day)",   rate: 0.0045 },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeekResult {
  unhedgedPnl: number;
  hedgedPnl: number;
  premiumPaid: number;
  payout: number;
  feeSplit: number;
  fees: number;
  rtIncome: number;
}

interface ConfigResult {
  widthLabel: string;
  widthBps: number;
  feeLabel: string;
  feeRate: number;
  weeks: WeekResult[];
  hedgedMean: number;
  hedgedStd: number;
  hedgedSharpe: number;
  hedgedSortino: number;
  hedgedCalmar: number;
  hedgedCVaR5: number;
  hedgedMaxDD: number;
  hedgedCumulative: number;
  unhedgedMean: number;
  unhedgedStd: number;
  unhedgedSharpe: number;
  unhedgedSortino: number;
  unhedgedCalmar: number;
  unhedgedCVaR5: number;
  unhedgedMaxDD: number;
  unhedgedCumulative: number;
  rtCumulative: number;
  rtMean: number;
  weeksWithPayout: number;
  totalWeeks: number;
}

interface BreakevenResult {
  widthLabel: string;
  widthBps: number;
  hedgedBreakeven: number;   // daily fee rate for hedged LP zero PnL
  unhedgedBreakeven: number; // daily fee rate for unhedged LP zero PnL
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
const sharpe = (a: number[]) => { const s = std(a); return s > 0 ? mean(a) / s : 0; };
const maxDrawdown = (a: number[]) => {
  let cum = 0, peak = 0, dd = 0;
  for (const r of a) { cum += r; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return dd;
};

/**
 * Downside deviation (negative-returns-only std) relative to a Minimum
 * Acceptable Return (default 0). Used in Sortino — unlike σ, it does
 * not penalise upside dispersion. The hedge caps upside (signed swap
 * surrenders S_T > p_u) so Sharpe is biased against it while Sortino
 * is not.
 */
const downsideDev = (a: number[], mar: number = 0) => {
  if (a.length < 2) return 0;
  const negSq = a
    .map((x) => Math.min(0, x - mar))
    .map((d) => d * d);
  return Math.sqrt(negSq.reduce((s, x) => s + x, 0) / a.length);
};

/**
 * Sortino ratio: mean / downside_deviation. Asymmetric — values the
 * hedge correctly because it removes only downside variance.
 */
const sortino = (a: number[], mar: number = 0) => {
  const dd = downsideDev(a, mar);
  return dd > 0 ? (mean(a) - mar) / dd : 0;
};

/**
 * Calmar ratio: cumulative return / max drawdown. Captures the hedge's
 * drawdown-protection value directly.
 */
const calmar = (a: number[]) => {
  const cum = a.reduce((s, x) => s + x, 0);
  const dd = maxDrawdown(a);
  return dd > 0 ? cum / dd : 0;
};

/**
 * Conditional Value-at-Risk (Expected Shortfall) at `alpha` confidence.
 * Average of the worst `alpha` fraction of returns. Negative = loss.
 * The hedge bounds max loss at Cap_down, so CVaR should improve.
 *
 * Default alpha = 0.05 → CVaR(5%) — average of worst 5% of weekly P&Ls.
 */
const cvar = (a: number[], alpha: number = 0.05) => {
  if (a.length === 0) return 0;
  const sorted = [...a].sort((x, y) => x - y);
  const n = Math.max(1, Math.floor(a.length * alpha));
  const tail = sorted.slice(0, n);
  return mean(tail);
};

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Simulated weekly fees (deterministic)
// ---------------------------------------------------------------------------

function simulateFees(posValueUsd: number, dailyRate: number, seed: number): number {
  // Deterministic pseudo-random with small noise around the rate
  let state = seed | 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  // Add ±30% noise around the rate
  const noise = 1 + 0.3 * (2 * u - 1);
  const effectiveRate = Math.max(0.0001, dailyRate * noise);
  return Math.floor(posValueUsd * effectiveRate * 7 * 1_000_000);
}

// ---------------------------------------------------------------------------
// Run one backtest configuration
// ---------------------------------------------------------------------------

interface BacktestParams {
  widthBps: number;
  dailyFeeRate: number;
  pfloorFraction: number;
  feeSplitRate: number;
  protocolFeeBps: number;
}

function defaultParams(overrides?: Partial<BacktestParams>): BacktestParams {
  return {
    widthBps: 1000,
    dailyFeeRate: 0.0025,
    pfloorFraction: PFLOOR_FRACTION,
    feeSplitRate: DEFAULT_POOL_CONFIG.feeSplitRate,
    protocolFeeBps: DEFAULT_POOL_CONFIG.protocolFeeBps,
    ...overrides,
  };
}

function runBacktest(
  weeklyPrices: { price: number; timestamp: number }[],
  widthBps: number,
  dailyFeeRate: number,
  volResult: VolatilityResult,
  pfloorFraction?: number,
  feeSplitRate?: number,
  protocolFeeBps?: number,
): WeekResult[] {
  const pf = pfloorFraction ?? PFLOOR_FRACTION;
  const fsr = feeSplitRate ?? DEFAULT_POOL_CONFIG.feeSplitRate;
  const pfb = protocolFeeBps ?? DEFAULT_POOL_CONFIG.protocolFeeBps;
  const WEEKS = weeklyPrices.length - 1;
  const results: WeekResult[] = [];

  const template: TemplateConfig = {
    templateId: 1,
    widthBps,
    tenorSeconds: 7 * 86_400,
    premiumCeilingUsdc: 50_000_000_000,
    expectedDailyFeeBps: Math.round(dailyFeeRate * 10_000),
  };

  for (let w = 0; w < WEEKS; w++) {
    const entryPrice = weeklyPrices[w].price;
    const settlePrice = weeklyPrices[w + 1].price;
    const entryPriceE6 = Math.floor(entryPrice * 1_000_000);
    const settlePriceE6 = Math.floor(settlePrice * 1_000_000);

    const pL = entryPrice * (1 - widthBps / 10_000);
    const pU = entryPrice * (1 + widthBps / 10_000);
    const V0 = clPositionValue(entryPrice, L, pL, pU);
    const VT = clPositionValue(settlePrice, L, pL, pU);

    const premiumFloorUsdc = Math.floor(pf * V0 * 1_000_000);

    const protocol = new OffchainLhProtocol();
    protocol.initPool("admin", {
      ...DEFAULT_POOL_CONFIG,
      expectedDailyFee: dailyFeeRate,
      premiumFloorUsdc,
      feeSplitRate: fsr,
      protocolFeeBps: pfb,
    });
    protocol.depositUsdc("rt-1", RT_DEPOSIT);
    protocol.createTemplate("admin", template);
    protocol.updateRegimeSnapshot("risk-svc", {
      sigmaPpm: volResult.sigmaPpm,
      sigma7dPpm: volResult.sigma7dPpm,
      stressFlag: volResult.stressFlag,
      carryBpsPerDay: 5,
      ivRvRatio: 1.08,
    });

    protocol.registerLockedPosition("lp-1", {
      positionMint: `pos-w${w}`,
      entryPriceE6,
      lowerTick: -1000,
      upperTick: 1000,
      liquidity: BigInt(L),
      entryValueE6: Math.floor(V0 * 1_000_000),
    });

    const buyResult = protocol.buyCertificate("lp-1", {
      positionMint: `pos-w${w}`,
      templateId: 1,
    });

    const feesUsdc = simulateFees(V0, dailyFeeRate, 42 + w);
    const settleResult = protocol.settleCertificate(
      "settler", `pos-w${w}`, settlePriceE6, feesUsdc, buyResult.expiryTs,
    );

    const positionPnl = VT - V0;
    const feesUsd = feesUsdc / 1_000_000;
    const premiumUsd = buyResult.premiumUsdc / 1_000_000;
    const payoutUsd = settleResult.payoutUsdc / 1_000_000;
    const feeSplitUsd = settleResult.rtFeeIncomeUsdc / 1_000_000;

    const unhedgedPnl = positionPnl + feesUsd;
    const hedgedPnl = positionPnl + feesUsd * (1 - fsr) - premiumUsd + payoutUsd;
    const rtIncome = premiumUsd * (1 - pfb / 10_000) + feeSplitUsd - payoutUsd;

    results.push({
      unhedgedPnl, hedgedPnl, premiumPaid: premiumUsd,
      payout: payoutUsd, feeSplit: feeSplitUsd, fees: feesUsd, rtIncome,
    });
  }

  return results;
}

function summarize(
  weeks: WeekResult[], widthLabel: string, widthBps: number,
  feeLabel: string, feeRate: number,
): ConfigResult {
  const h = weeks.map(w => w.hedgedPnl);
  const u = weeks.map(w => w.unhedgedPnl);
  const rt = weeks.map(w => w.rtIncome);
  return {
    widthLabel, widthBps, feeLabel, feeRate, weeks,
    hedgedMean: mean(h), hedgedStd: std(h), hedgedSharpe: sharpe(h),
    hedgedSortino: sortino(h), hedgedCalmar: calmar(h), hedgedCVaR5: cvar(h, 0.05),
    hedgedMaxDD: maxDrawdown(h), hedgedCumulative: h.reduce((a, b) => a + b, 0),
    unhedgedMean: mean(u), unhedgedStd: std(u), unhedgedSharpe: sharpe(u),
    unhedgedSortino: sortino(u), unhedgedCalmar: calmar(u), unhedgedCVaR5: cvar(u, 0.05),
    unhedgedMaxDD: maxDrawdown(u), unhedgedCumulative: u.reduce((a, b) => a + b, 0),
    rtCumulative: rt.reduce((a, b) => a + b, 0), rtMean: mean(rt),
    weeksWithPayout: weeks.filter(w => w.payout > 0).length,
    totalWeeks: weeks.length,
  };
}

// ---------------------------------------------------------------------------
// Breakeven analysis: binary search for the daily fee rate where PnL = 0
// ---------------------------------------------------------------------------

function findBreakeven(
  weeklyPrices: { price: number; timestamp: number }[],
  widthBps: number,
  volResult: VolatilityResult,
  target: "hedged" | "unhedged",
  lo: number = 0.00001,
  hi: number = 0.02,
  tolerance: number = 0.00001,
  maxIter: number = 40,
  pfloorFraction?: number,
  feeSplitRate?: number,
): number {
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const weeks = runBacktest(weeklyPrices, widthBps, mid, volResult, pfloorFraction, feeSplitRate);
    const cumPnl = weeks.reduce((s, w) =>
      s + (target === "hedged" ? w.hedgedPnl : w.unhedgedPnl), 0);

    if (Math.abs(cumPnl) < 0.01 || (hi - lo) < tolerance) return mid;
    if (cumPnl < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    console.error(
      "ERROR: BIRDEYE_API_KEY is not set.\n" +
      "Either create a .env file with BIRDEYE_API_KEY=<your-key>\n" +
      "or run: BIRDEYE_API_KEY=<your-key> npx ts-node scripts/live-scenario-test.ts",
    );
    process.exit(1);
  }

  // ── 1. Fetch real data ──────────────────────────────────────
  console.log("Fetching weekly SOL/USDC prices from Birdeye...");
  const weeklyPrices = await fetchWeeklyPrices(apiKey, 56);

  if (weeklyPrices.length < MIN_WEEKS + 1) {
    console.error(
      `ERROR: Birdeye returned only ${weeklyPrices.length} weekly prices. Need at least ${MIN_WEEKS + 1}.`,
    );
    process.exit(1);
  }

  console.log("Fetching 15-minute candles (30 days) for volatility...");
  const candles15m: OHLCVCandle[] = await fetchOHLCV(apiKey, 30, "15m");
  const volResult: VolatilityResult = computeVolatility(candles15m, "15m");

  const WEEKS = weeklyPrices.length - 1;
  const startDate = formatDate(weeklyPrices[0].timestamp);
  const endDate = formatDate(weeklyPrices[weeklyPrices.length - 1].timestamp);
  const sigma30d = (volResult.sigmaPpm / 1_000_000 * 100).toFixed(1);
  const sigma7d = (volResult.sigma7dPpm / 1_000_000 * 100).toFixed(1);

  // ── 2. Header ───────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("  Liquidity Hedge Protocol — Multi-Width, Multi-Yield Backtest");
  console.log("=".repeat(72));
  console.log(`\nData source:  Birdeye API (real SOL/USDC prices)`);
  console.log(`Date range:   ${startDate} to ${endDate} (${WEEKS} weeks)`);
  console.log(`Volatility:   30d = ${sigma30d}%, 7d = ${sigma7d}%, stress = ${volResult.stressFlag}`);
  // Compute reference position value at first week's price
  const refPrice = weeklyPrices[0].price;
  const refPL = refPrice * 0.90;
  const refPU = refPrice * 1.10;
  const refV0 = clPositionValue(refPrice, L, refPL, refPU);
  const refCap = naturalCap(refPrice, L, refPL, refPU);
  const refPfloor = PFLOOR_FRACTION * refV0;

  console.log(`Position:     L=${L.toLocaleString()}, V(S_0) ≈ $${refV0.toFixed(0)}, Cap ≈ $${refCap.toFixed(0)}`);
  console.log(`P_floor:      ${(PFLOOR_FRACTION * 100).toFixed(0)}% of position value ≈ $${refPfloor.toFixed(2)}/week`);
  console.log(`RT deposit:   $${(RT_DEPOSIT / 1e6).toLocaleString()}`);
  console.log(`Fee split:    ${(DEFAULT_POOL_CONFIG.feeSplitRate * 100).toFixed(0)}%`);

  // ── 3. Run full matrix ──────────────────────────────────────
  console.log("\n" + "-".repeat(72));
  console.log("  SECTION 1: Performance by Width x Fee Tier");
  console.log("-".repeat(72));

  const allResults: ConfigResult[] = [];

  for (const width of WIDTHS) {
    for (const fee of FEE_TIERS) {
      const weeks = runBacktest(weeklyPrices, width.bps, fee.rate, volResult);
      const result = summarize(weeks, width.label, width.bps, fee.label, fee.rate);
      allResults.push(result);
    }
  }

  // Print comparison table
  console.log("\n### Hedged LP Sharpe Ratio\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      return r.hedgedSharpe.toFixed(3);
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### Unhedged LP Sharpe Ratio\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      return r.unhedgedSharpe.toFixed(3);
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  // ── Asymmetric-risk metrics (Sortino, Calmar, CVaR) ─────────────────
  // Sharpe alone is biased against the hedge because it penalises
  // upside variance (which the signed swap cedes to the RT). The
  // metrics below decompose downside vs total risk so the hedge's
  // actual value — asymmetric loss truncation — is visible.

  console.log("\n### Hedge Δ on Sortino ratio (hedged − unhedged, positive = hedge wins)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      const delta = r.hedgedSortino - r.unhedgedSortino;
      return `${r.hedgedSortino.toFixed(2)}/${r.unhedgedSortino.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`;
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### Hedge Δ on Calmar ratio (hedged − unhedged, positive = hedge wins)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      const delta = r.hedgedCalmar - r.unhedgedCalmar;
      return `${r.hedgedCalmar.toFixed(2)}/${r.unhedgedCalmar.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`;
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### CVaR(5%) of weekly P&L — avg of worst 5% of weeks ($; less negative = hedge wins)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      const reductionPct = r.unhedgedCVaR5 < 0
        ? ((r.hedgedCVaR5 - r.unhedgedCVaR5) / Math.abs(r.unhedgedCVaR5)) * 100
        : 0;
      return `$${r.hedgedCVaR5.toFixed(0)}/$${r.unhedgedCVaR5.toFixed(0)} (${reductionPct >= 0 ? "+" : ""}${reductionPct.toFixed(0)}%)`;
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### Hedged LP Cumulative PnL ($)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      return r.hedgedCumulative.toFixed(2);
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### Unhedged LP Cumulative PnL ($)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      return r.unhedgedCumulative.toFixed(2);
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### RT Cumulative PnL ($)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      return r.rtCumulative.toFixed(2);
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  console.log("\n### Max Drawdown — Hedged vs Unhedged ($)\n");
  console.log(`| Width | Fee Tier | Hedged DD | Unhedged DD | Reduction |`);
  console.log(`|-------|----------|-----------|-------------|-----------|`);
  for (const r of allResults) {
    const reduction = r.unhedgedMaxDD > 0
      ? ((1 - r.hedgedMaxDD / r.unhedgedMaxDD) * 100).toFixed(0) + "%"
      : "N/A";
    console.log(`| ${r.widthLabel.padEnd(5)} | ${r.feeLabel.padEnd(20)} | $${r.hedgedMaxDD.toFixed(2).padStart(8)} | $${r.unhedgedMaxDD.toFixed(2).padStart(10)} | ${reduction.padStart(9)} |`);
  }

  console.log("\n### Volatility Reduction (Hedged std / Unhedged std)\n");
  console.log(`| Width | ${FEE_TIERS.map(f => f.label).join(" | ")} |`);
  console.log(`|-------|${FEE_TIERS.map(() => "---").join("|")}|`);
  for (const width of WIDTHS) {
    const row = FEE_TIERS.map(fee => {
      const r = allResults.find(x => x.widthBps === width.bps && x.feeRate === fee.rate)!;
      const reduction = r.unhedgedStd > 0
        ? ((1 - r.hedgedStd / r.unhedgedStd) * 100).toFixed(1) + "%"
        : "N/A";
      return reduction;
    });
    console.log(`| ${width.label.padEnd(5)} | ${row.join(" | ")} |`);
  }

  // ── 4. Breakeven analysis ───────────────────────────────────
  console.log("\n" + "-".repeat(72));
  console.log("  SECTION 2: Breakeven Daily Fee Rate Analysis");
  console.log("-".repeat(72));
  console.log("\nThe breakeven rate is the daily LP fee yield at which the");
  console.log("strategy produces zero cumulative PnL over the backtest period.\n");

  const breakevenResults: BreakevenResult[] = [];

  for (const width of WIDTHS) {
    process.stdout.write(`  Computing breakeven for ${width.label}...`);
    const hedgedBE = findBreakeven(weeklyPrices, width.bps, volResult, "hedged");
    const unhedgedBE = findBreakeven(weeklyPrices, width.bps, volResult, "unhedged");
    breakevenResults.push({
      widthLabel: width.label,
      widthBps: width.bps,
      hedgedBreakeven: hedgedBE,
      unhedgedBreakeven: unhedgedBE,
    });
    console.log(` done`);
  }

  console.log("\n### Breakeven Daily Fee Rate\n");
  console.log("| Width | Hedged LP Breakeven | Unhedged LP Breakeven | Hedge Premium Cost |");
  console.log("|-------|--------------------|-----------------------|--------------------|");
  for (const be of breakevenResults) {
    const hedgedPct = (be.hedgedBreakeven * 100).toFixed(3);
    const unhedgedPct = (be.unhedgedBreakeven * 100).toFixed(3);
    const costBps = ((be.hedgedBreakeven - be.unhedgedBreakeven) * 10_000).toFixed(1);
    console.log(`| ${be.widthLabel.padEnd(5)} | ${hedgedPct.padStart(16)}%/day | ${unhedgedPct.padStart(19)}%/day | ${costBps.padStart(14)} bps/day |`);
  }

  console.log("\nInterpretation:");
  console.log("- 'Hedged LP Breakeven': the minimum daily fee yield an LP needs to");
  console.log("  break even when paying for Liquidity Hedge protection.");
  console.log("- 'Unhedged LP Breakeven': the minimum daily fee yield to break even");
  console.log("  without any hedge (purely from IL + fees).");
  console.log("- 'Hedge Premium Cost': additional yield needed to cover the hedge cost,");
  console.log("  i.e. the insurance premium expressed in bps/day of position value.");

  // ── 5. RT breakeven parameter search ─────────────────────────
  console.log("\n" + "-".repeat(72));
  console.log("  SECTION 3: RT Breakeven Parameter Optimization");
  console.log("-".repeat(72));
  console.log("\nSearches across P_floor (% of position value) and fee-split rate");
  console.log("to find the parameter combination where the RT breaks even (cumPnL ≥ 0),");
  console.log("with the lowest impact on LP returns.\n");

  // Parameter grid
  const PFLOOR_GRID = [0.005, 0.010, 0.015, 0.020, 0.025, 0.030, 0.040, 0.050];
  const FEESPLIT_GRID = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
  const SEARCH_FEE_RATE = 0.0025; // medium yield for the search

  interface RTSearchResult {
    widthLabel: string;
    widthBps: number;
    pfloorPct: number;
    feeSplitPct: number;
    rtCumulative: number;
    hedgedCumulative: number;
    hedgedSharpe: number;
    hedgedBreakevenDaily: number;
    avgPremiumPerWeek: number;
    avgPayoutPerWeek: number;
  }

  const searchResults: RTSearchResult[] = [];

  for (const width of WIDTHS) {
    process.stdout.write(`  Sweeping ${width.label}: `);
    let count = 0;
    for (const pf of PFLOOR_GRID) {
      for (const fs of FEESPLIT_GRID) {
        const weeks = runBacktest(
          weeklyPrices, width.bps, SEARCH_FEE_RATE, volResult, pf, fs,
        );
        const h = weeks.map(w => w.hedgedPnl);
        const rt = weeks.map(w => w.rtIncome);
        const rtCum = rt.reduce((a, b) => a + b, 0);
        const hedgedCum = h.reduce((a, b) => a + b, 0);

        searchResults.push({
          widthLabel: width.label,
          widthBps: width.bps,
          pfloorPct: pf * 100,
          feeSplitPct: fs * 100,
          rtCumulative: rtCum,
          hedgedCumulative: hedgedCum,
          hedgedSharpe: sharpe(h),
          hedgedBreakevenDaily: 0, // computed below for winners
          avgPremiumPerWeek: weeks.reduce((s, w) => s + w.premiumPaid, 0) / weeks.length,
          avgPayoutPerWeek: weeks.reduce((s, w) => s + w.payout, 0) / weeks.length,
        });
        count++;
      }
    }
    console.log(`${count} configurations tested`);
  }

  // Find RT-viable configs (rtCumulative >= 0) and rank by LP impact
  const rtViable = searchResults.filter(r => r.rtCumulative >= 0);

  if (rtViable.length === 0) {
    console.log("\n### No RT-viable configuration found at medium yield (0.25%/day)");
    console.log("The RT requires higher fee yields or higher P_floor to break even.\n");

    // Show the closest-to-breakeven configs
    const closest = [...searchResults]
      .sort((a, b) => b.rtCumulative - a.rtCumulative)
      .slice(0, 10);
    console.log("### Closest to RT breakeven (top 10)\n");
    console.log("| Width | P_floor | Fee Split | RT PnL | Hedged LP PnL | Avg Premium/wk | Avg Payout/wk |");
    console.log("|-------|---------|-----------|--------|---------------|----------------|---------------|");
    for (const r of closest) {
      console.log(
        `| ${r.widthLabel.padEnd(5)} | ${r.pfloorPct.toFixed(1).padStart(5)}% | ${r.feeSplitPct.toFixed(0).padStart(7)}% | $${r.rtCumulative.toFixed(0).padStart(7)} | $${r.hedgedCumulative.toFixed(0).padStart(12)} | $${r.avgPremiumPerWeek.toFixed(2).padStart(13)} | $${r.avgPayoutPerWeek.toFixed(2).padStart(12)} |`,
      );
    }
  } else {
    // Rank viable configs by highest hedged LP Sharpe (best for LP while RT is viable)
    const ranked = [...rtViable].sort((a, b) => b.hedgedSharpe - a.hedgedSharpe);

    console.log(`### RT-Viable Configurations (${rtViable.length} found at medium yield)\n`);
    console.log("Ranked by hedged LP Sharpe ratio (best LP outcome while RT ≥ breakeven):\n");
    console.log("| Rank | Width | P_floor | Fee Split | RT PnL | Hedged LP PnL | LP Sharpe | Avg Premium/wk | Avg Payout/wk |");
    console.log("|------|-------|---------|-----------|--------|---------------|-----------|----------------|---------------|");

    const show = Math.min(15, ranked.length);
    for (let i = 0; i < show; i++) {
      const r = ranked[i];
      console.log(
        `| ${(i + 1).toString().padStart(4)} | ${r.widthLabel.padEnd(5)} | ${r.pfloorPct.toFixed(1).padStart(5)}% | ${r.feeSplitPct.toFixed(0).padStart(7)}% | $${r.rtCumulative.toFixed(0).padStart(7)} | $${r.hedgedCumulative.toFixed(0).padStart(12)} | ${r.hedgedSharpe.toFixed(3).padStart(9)} | $${r.avgPremiumPerWeek.toFixed(2).padStart(13)} | $${r.avgPayoutPerWeek.toFixed(2).padStart(12)} |`,
      );
    }

    // Best overall
    const best = ranked[0];
    console.log(`\n**Optimal configuration:** ${best.widthLabel}, P_floor=${best.pfloorPct.toFixed(1)}%, fee_split=${best.feeSplitPct.toFixed(0)}%`);
    console.log(`  RT cumulative: $${best.rtCumulative.toFixed(2)}`);
    console.log(`  Hedged LP cumulative: $${best.hedgedCumulative.toFixed(2)}`);
    console.log(`  Hedged LP Sharpe: ${best.hedgedSharpe.toFixed(3)}`);
    console.log(`  Avg premium/week: $${best.avgPremiumPerWeek.toFixed(2)} (${(best.avgPremiumPerWeek / refV0 * 100).toFixed(2)}% of position)`);
    console.log(`  Avg payout/week: $${best.avgPayoutPerWeek.toFixed(2)}`);
  }

  // Also find the minimum P_floor that achieves RT breakeven for each width
  console.log("\n### Minimum P_floor for RT Breakeven (by width, fee split = 10%)\n");
  console.log("Binary search for the P_floor fraction where RT cumPnL = 0:\n");

  for (const width of WIDTHS) {
    let lo = 0.001, hi = 0.10;
    for (let iter = 0; iter < 40; iter++) {
      const mid = (lo + hi) / 2;
      const weeks = runBacktest(weeklyPrices, width.bps, SEARCH_FEE_RATE, volResult, mid, 0.10);
      const rtCum = weeks.reduce((s, w) => s + w.rtIncome, 0);
      if (rtCum < 0) lo = mid; else hi = mid;
    }
    const pfloorBE = (lo + hi) / 2;
    // Compute the resulting LP metrics AT the RT-breakeven P_floor
    const weeks = runBacktest(weeklyPrices, width.bps, SEARCH_FEE_RATE, volResult, pfloorBE, 0.10);
    const hedgedCum = weeks.reduce((s, w) => s + w.hedgedPnl, 0);
    const hedgedBE = findBreakeven(
      weeklyPrices, width.bps, volResult, "hedged",
      0.00001, 0.02, 0.00001, 40, pfloorBE, 0.10,
    );
    const unhedgedBE = findBreakeven(weeklyPrices, width.bps, volResult, "unhedged");
    const avgPremium = weeks.reduce((s, w) => s + w.premiumPaid, 0) / weeks.length;
    const avgPayout = weeks.reduce((s, w) => s + w.payout, 0) / weeks.length;

    console.log(`  ${width.label}: P_floor = ${(pfloorBE * 100).toFixed(2)}% of position ($${(pfloorBE * refV0).toFixed(2)}/week)`);
    console.log(`    → RT breaks even, hedged LP cumPnL at 0.25%/day = $${hedgedCum.toFixed(2)}`);
    console.log(`    → Avg premium: $${avgPremium.toFixed(2)}/wk, avg payout: $${avgPayout.toFixed(2)}/wk`);
    console.log(`    → Hedged LP breakeven yield: ${(hedgedBE * 100).toFixed(3)}%/day (unhedged: ${(unhedgedBE * 100).toFixed(3)}%/day)`);
    console.log(`    → Hedge cost: ${((hedgedBE - unhedgedBE) * 10_000).toFixed(1)} bps/day additional yield needed`);
    console.log("");
  }

  // ── 6. Two-sided viability: minimum fee yield ───────────────
  console.log("-".repeat(72));
  console.log("  SECTION 4: Two-Sided Viability — Minimum Fee Yield");
  console.log("-".repeat(72));
  console.log("\nFinds the lowest daily fee yield at which BOTH the hedged LP");
  console.log("and the RT have non-negative cumulative PnL over the backtest.");
  console.log("For each fee yield, optimizes over P_floor and fee-split rate.\n");

  interface TwoSidedResult {
    widthLabel: string;
    widthBps: number;
    minYield: number;
    bestPfloor: number;
    bestFeeSplit: number;
    rtPnl: number;
    lpPnl: number;
    lpSharpe: number;
    unhedgedPnl: number;
    unhedgedBE: number;
    hedgeCostBps: number;
    avgPremium: number;
    avgPayout: number;
  }

  /**
   * For a given (width, feeRate, feeSplitRate), binary-search for the
   * P_floor fraction that puts RT at exactly breakeven. Returns the
   * pfloor fraction and the resulting LP cumulative PnL.
   */
  function findRtBreakevenPfloor(
    wp: typeof weeklyPrices,
    widthBps: number,
    feeRate: number,
    vol: VolatilityResult,
    feeSplitRate: number,
  ): { pfloor: number; rtCum: number; lpCum: number; lpSharpe: number; avgPremium: number; avgPayout: number } | null {
    let lo = 0.0001, hi = 0.10;
    // First check: can RT break even at all at max P_floor?
    const maxWeeks = runBacktest(wp, widthBps, feeRate, vol, hi, feeSplitRate);
    const rtAtMax = maxWeeks.reduce((s, w) => s + w.rtIncome, 0);
    if (rtAtMax < 0) return null; // RT can't break even even at 10% P_floor

    // Check: is RT already positive at min P_floor?
    const minWeeks = runBacktest(wp, widthBps, feeRate, vol, lo, feeSplitRate);
    const rtAtMin = minWeeks.reduce((s, w) => s + w.rtIncome, 0);
    if (rtAtMin >= 0) lo = 0.0001; // RT is already viable at very low P_floor

    for (let i = 0; i < 35; i++) {
      const mid = (lo + hi) / 2;
      const weeks = runBacktest(wp, widthBps, feeRate, vol, mid, feeSplitRate);
      const rtCum = weeks.reduce((s, w) => s + w.rtIncome, 0);
      if (Math.abs(rtCum) < 1.0 || (hi - lo) < 0.00005) {
        const lpCum = weeks.reduce((s, w) => s + w.hedgedPnl, 0);
        const h = weeks.map(w => w.hedgedPnl);
        return {
          pfloor: mid,
          rtCum,
          lpCum,
          lpSharpe: sharpe(h),
          avgPremium: weeks.reduce((s, w) => s + w.premiumPaid, 0) / weeks.length,
          avgPayout: weeks.reduce((s, w) => s + w.payout, 0) / weeks.length,
        };
      }
      if (rtCum < 0) lo = mid; else hi = mid;
    }
    const finalWeeks = runBacktest(wp, widthBps, (lo + hi) / 2, vol, (lo + hi) / 2, feeSplitRate);
    const h = finalWeeks.map(w => w.hedgedPnl);
    return {
      pfloor: (lo + hi) / 2,
      rtCum: finalWeeks.reduce((s, w) => s + w.rtIncome, 0),
      lpCum: finalWeeks.reduce((s, w) => s + w.hedgedPnl, 0),
      lpSharpe: sharpe(h),
      avgPremium: finalWeeks.reduce((s, w) => s + w.premiumPaid, 0) / finalWeeks.length,
      avgPayout: finalWeeks.reduce((s, w) => s + w.payout, 0) / finalWeeks.length,
    };
  }

  const twoSidedResults: TwoSidedResult[] = [];
  const FEESPLIT_CANDIDATES = [0.05, 0.10, 0.15, 0.20, 0.25];

  for (const width of WIDTHS) {
    process.stdout.write(`  ${width.label}: searching...`);

    // Binary search on fee yield
    let yieldLo = 0.0005, yieldHi = 0.015;
    let bestResult: TwoSidedResult | null = null;

    for (let yIter = 0; yIter < 30; yIter++) {
      const yieldMid = (yieldLo + yieldHi) / 2;

      // For this fee yield, try each fee split rate and find the best
      let bestLpAtThisYield = -Infinity;
      let bestConfigAtThisYield: {
        feeSplit: number; pfloor: number; rtCum: number; lpCum: number;
        lpSharpe: number; avgPremium: number; avgPayout: number;
      } | null = null;

      for (const fs of FEESPLIT_CANDIDATES) {
        const res = findRtBreakevenPfloor(weeklyPrices, width.bps, yieldMid, volResult, fs);
        if (res && res.lpCum > bestLpAtThisYield) {
          bestLpAtThisYield = res.lpCum;
          bestConfigAtThisYield = { feeSplit: fs, ...res };
        }
      }

      if (!bestConfigAtThisYield || bestLpAtThisYield < -10) {
        // LP is underwater or RT can't break even → need higher yield
        yieldLo = yieldMid;
      } else if (bestLpAtThisYield > 100) {
        // LP has margin → can try lower yield
        yieldHi = yieldMid;
        bestResult = {
          widthLabel: width.label,
          widthBps: width.bps,
          minYield: yieldMid,
          bestPfloor: bestConfigAtThisYield.pfloor,
          bestFeeSplit: bestConfigAtThisYield.feeSplit,
          rtPnl: bestConfigAtThisYield.rtCum,
          lpPnl: bestConfigAtThisYield.lpCum,
          lpSharpe: bestConfigAtThisYield.lpSharpe,
          unhedgedPnl: 0,
          unhedgedBE: 0,
          hedgeCostBps: 0,
          avgPremium: bestConfigAtThisYield.avgPremium,
          avgPayout: bestConfigAtThisYield.avgPayout,
        };
      } else {
        // Near the boundary — record and refine
        bestResult = {
          widthLabel: width.label,
          widthBps: width.bps,
          minYield: yieldMid,
          bestPfloor: bestConfigAtThisYield.pfloor,
          bestFeeSplit: bestConfigAtThisYield.feeSplit,
          rtPnl: bestConfigAtThisYield.rtCum,
          lpPnl: bestConfigAtThisYield.lpCum,
          lpSharpe: bestConfigAtThisYield.lpSharpe,
          unhedgedPnl: 0,
          unhedgedBE: 0,
          hedgeCostBps: 0,
          avgPremium: bestConfigAtThisYield.avgPremium,
          avgPayout: bestConfigAtThisYield.avgPayout,
        };
        yieldHi = yieldMid;
      }
    }

    if (bestResult) {
      // Compute unhedged breakeven for comparison
      const unBE = findBreakeven(weeklyPrices, width.bps, volResult, "unhedged");
      bestResult.unhedgedBE = unBE;
      bestResult.hedgeCostBps = (bestResult.minYield - unBE) * 10_000;

      // Compute unhedged PnL at the two-sided min yield
      const unWeeks = runBacktest(weeklyPrices, width.bps, bestResult.minYield, volResult, 0.001, 0);
      bestResult.unhedgedPnl = unWeeks.reduce((s, w) => s + w.unhedgedPnl, 0);

      twoSidedResults.push(bestResult);
    }

    console.log(` done`);
  }

  console.log("\n### Two-Sided Breakeven: Minimum Daily Fee Yield\n");
  console.log("The lowest fee yield at which both LP (hedged) and RT have cumPnL ≥ 0:\n");
  console.log("| Width | Min Yield | P_floor | Fee Split | LP PnL | RT PnL | LP Sharpe | Unhedged BE | Hedge Cost |");
  console.log("|-------|-----------|---------|-----------|--------|--------|-----------|-------------|------------|");
  for (const r of twoSidedResults) {
    console.log(
      `| ${r.widthLabel.padEnd(5)} | ${(r.minYield * 100).toFixed(3)}%/day | ${(r.bestPfloor * 100).toFixed(2).padStart(5)}% | ${(r.bestFeeSplit * 100).toFixed(0).padStart(7)}% | $${r.lpPnl.toFixed(0).padStart(6)} | $${r.rtPnl.toFixed(0).padStart(5)} | ${r.lpSharpe.toFixed(3).padStart(9)} | ${(r.unhedgedBE * 100).toFixed(3)}%/day | ${r.hedgeCostBps.toFixed(1).padStart(7)} bps |`,
    );
  }

  console.log("\n### Detailed Breakdown at Two-Sided Breakeven\n");
  for (const r of twoSidedResults) {
    const posV = clPositionValue(weeklyPrices[0].price, L,
      weeklyPrices[0].price * (1 - r.widthBps / 10_000),
      weeklyPrices[0].price * (1 + r.widthBps / 10_000));
    console.log(`  ${r.widthLabel}:`);
    console.log(`    Min daily yield:    ${(r.minYield * 100).toFixed(3)}%/day (${(r.minYield * 365 * 100).toFixed(1)}% APR)`);
    console.log(`    Unhedged breakeven: ${(r.unhedgedBE * 100).toFixed(3)}%/day (${(r.unhedgedBE * 365 * 100).toFixed(1)}% APR)`);
    console.log(`    Hedge cost:         ${r.hedgeCostBps.toFixed(1)} bps/day (${(r.hedgeCostBps * 365 / 100).toFixed(1)}% APR)`);
    console.log(`    Optimal P_floor:    ${(r.bestPfloor * 100).toFixed(2)}% of position ($${(r.bestPfloor * posV).toFixed(2)}/week)`);
    console.log(`    Optimal fee split:  ${(r.bestFeeSplit * 100).toFixed(0)}%`);
    console.log(`    Avg premium/week:   $${r.avgPremium.toFixed(2)} (${(r.avgPremium / posV * 100).toFixed(2)}% of position)`);
    console.log(`    Avg payout/week:    $${r.avgPayout.toFixed(2)}`);
    console.log(`    Unhedged LP PnL:    $${r.unhedgedPnl.toFixed(2)} (at same yield, no hedge)`);
    console.log("");
  }

  // ── 7. Detailed results for the medium fee tier ─────────────
  console.log("-".repeat(72));
  console.log("  SECTION 5: Detailed Weekly Results (Medium Yield, ±10%)");
  console.log("-".repeat(72));

  const detailResult = allResults.find(
    r => r.widthBps === 1000 && r.feeRate === 0.0025,
  );
  if (detailResult) {
    console.log("\n| Week | Entry ($) | Settle ($) | Change | Unhedged | Hedged | Premium | Payout |");
    console.log("|------|-----------|------------|--------|----------|--------|---------|--------|");
    const showWeeks = Math.min(20, detailResult.weeks.length);
    for (let i = 0; i < showWeeks; i++) {
      const w = detailResult.weeks[i];
      const entry = weeklyPrices[i].price;
      const settle = weeklyPrices[i + 1].price;
      const change = ((settle - entry) / entry * 100).toFixed(1);
      console.log(
        `| ${(i + 1).toString().padStart(4)} | $${entry.toFixed(1).padStart(8)} | $${settle.toFixed(1).padStart(9)} | ${change.padStart(5)}% | $${w.unhedgedPnl.toFixed(2).padStart(7)} | $${w.hedgedPnl.toFixed(2).padStart(5)} | $${w.premiumPaid.toFixed(2).padStart(6)} | $${w.payout.toFixed(2).padStart(5)} |`,
      );
    }
    if (detailResult.weeks.length > showWeeks) {
      console.log(`| ... ${detailResult.weeks.length - showWeeks} more weeks omitted |`);
    }
  }

  // ── 6. Summary ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("  SUMMARY");
  console.log("=".repeat(72));
  console.log(`\nData: ${WEEKS} weeks of real SOL/USDC prices (${startDate} to ${endDate})`);
  console.log(`Realized vol: ${sigma30d}% (30d), ${sigma7d}% (7d)`);

  // Find best config for hedged LP
  const bestHedged = allResults.reduce((a, b) => a.hedgedSharpe > b.hedgedSharpe ? a : b);
  console.log(`\nBest hedged LP Sharpe: ${bestHedged.hedgedSharpe.toFixed(3)} at ${bestHedged.widthLabel}, ${bestHedged.feeLabel}`);

  // Find config where RT is most profitable
  const bestRT = allResults.reduce((a, b) => a.rtCumulative > b.rtCumulative ? a : b);
  console.log(`Best RT outcome: $${bestRT.rtCumulative.toFixed(2)} at ${bestRT.widthLabel}, ${bestRT.feeLabel}`);

  console.log("\nNote: LP fees are simulated — real per-position fee data is not");
  console.log("available from Birdeye. For ground-truth fee data, use live-orca-test.ts.");
}

// Only auto-run when invoked directly; allow imports for programmatic reuse
// (e.g. `generate-summary-charts.ts` runs `main()` or the helpers below).
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Standalone joint-breakeven search — self-contained, exportable
// ---------------------------------------------------------------------------

interface JointBEResult {
  minYield: number;
  bestPfloor: number;
  bestFeeSplit: number;
  rtPnl: number;
  lpPnl: number;
  avgPremiumPerWeek: number;
  avgPayoutPerWeek: number;
}

/**
 * For fixed (width, feeRate, feeSplit), binary-search for the P_floor
 * fraction where RT cumulative PnL = 0 over the backtest. Returns the
 * winning config or null if RT can't break even at any P_floor in [1bp, 10%].
 */
function rtBreakevenPfloor(
  weeklyPrices: { price: number; timestamp: number }[],
  widthBps: number,
  feeRate: number,
  vol: VolatilityResult,
  feeSplit: number,
): { pfloor: number; rtCum: number; lpCum: number; avgP: number; avgPayout: number } | null {
  let lo = 0.0001, hi = 0.10;
  const maxWeeks = runBacktest(weeklyPrices, widthBps, feeRate, vol, hi, feeSplit);
  const rtAtMax = maxWeeks.reduce((s, w) => s + w.rtIncome, 0);
  if (rtAtMax < 0) return null;

  for (let i = 0; i < 35; i++) {
    const mid = (lo + hi) / 2;
    const weeks = runBacktest(weeklyPrices, widthBps, feeRate, vol, mid, feeSplit);
    const rtCum = weeks.reduce((s, w) => s + w.rtIncome, 0);
    if (Math.abs(rtCum) < 1.0 || (hi - lo) < 5e-5) {
      return {
        pfloor: mid,
        rtCum,
        lpCum: weeks.reduce((s, w) => s + w.hedgedPnl, 0),
        avgP: weeks.reduce((s, w) => s + w.premiumPaid, 0) / weeks.length,
        avgPayout: weeks.reduce((s, w) => s + w.payout, 0) / weeks.length,
      };
    }
    if (rtCum < 0) lo = mid; else hi = mid;
  }
  const finalMid = (lo + hi) / 2;
  const finalWeeks = runBacktest(weeklyPrices, widthBps, feeRate, vol, finalMid, feeSplit);
  return {
    pfloor: finalMid,
    rtCum: finalWeeks.reduce((s, w) => s + w.rtIncome, 0),
    lpCum: finalWeeks.reduce((s, w) => s + w.hedgedPnl, 0),
    avgP: finalWeeks.reduce((s, w) => s + w.premiumPaid, 0) / finalWeeks.length,
    avgPayout: finalWeeks.reduce((s, w) => s + w.payout, 0) / finalWeeks.length,
  };
}

/**
 * Two-sided breakeven: the minimum daily fee yield at which both hedged
 * LP and RT end with non-negative cumulative PnL, optimised over
 * P_floor and fee-split. Returns null if not reachable in [5 bp, 1.5%]/day.
 */
export function findJointBreakeven(
  weeklyPrices: { price: number; timestamp: number }[],
  widthBps: number,
  vol: VolatilityResult,
): JointBEResult {
  const FEESPLIT_GRID = [0.05, 0.10, 0.15, 0.20, 0.25];
  let yieldLo = 0.0005, yieldHi = 0.015;
  let best: JointBEResult | null = null;

  for (let i = 0; i < 30; i++) {
    const yieldMid = (yieldLo + yieldHi) / 2;
    let bestLpAtYield = -Infinity;
    let bestConfig: { feeSplit: number; pfloor: number; rtCum: number; lpCum: number; avgP: number; avgPayout: number } | null = null;

    for (const fs of FEESPLIT_GRID) {
      const res = rtBreakevenPfloor(weeklyPrices, widthBps, yieldMid, vol, fs);
      if (res && res.lpCum > bestLpAtYield) {
        bestLpAtYield = res.lpCum;
        bestConfig = { feeSplit: fs, ...res };
      }
    }

    if (!bestConfig || bestLpAtYield < -10) {
      yieldLo = yieldMid;
    } else {
      best = {
        minYield: yieldMid,
        bestPfloor: bestConfig.pfloor,
        bestFeeSplit: bestConfig.feeSplit,
        rtPnl: bestConfig.rtCum,
        lpPnl: bestConfig.lpCum,
        avgPremiumPerWeek: bestConfig.avgP,
        avgPayoutPerWeek: bestConfig.avgPayout,
      };
      yieldHi = yieldMid;
    }
  }

  if (!best) {
    throw new Error(`joint breakeven not found for width ${widthBps}`);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Programmatic export: run the full backtest and return a structured result
// for chart generators / summary writers.
// ---------------------------------------------------------------------------

export interface FullBacktestResult {
  meta: {
    weeksUsed: number;
    dateRange: { from: string; to: string };
    vol: VolatilityResult;
  };
  /** Per (width, fee) cell — all summarised stats */
  cells: ConfigResult[];
  /** Two-sided breakeven per width */
  jointBreakevens: {
    widthLabel: string;
    widthBps: number;
    minYield: number;
    unhedgedBE: number;
    hedgeCostBps: number;
    avgPremiumPerWeek: number;
    avgPayoutPerWeek: number;
    lpPnl: number;
    rtPnl: number;
  }[];
}

/**
 * Run the complete backtest non-interactively and return structured
 * data. Used by `generate-summary-charts.ts` so the charts always
 * reflect the same computation the markdown tables do.
 */
export async function runFullBacktest(
  apiKey: string,
  weeksTarget: number = 52,
): Promise<FullBacktestResult> {
  const weeklyPrices = await fetchWeeklyPrices(apiKey, weeksTarget);
  if (weeklyPrices.length < MIN_WEEKS) {
    throw new Error(
      `insufficient weekly prices: ${weeklyPrices.length} < ${MIN_WEEKS}`,
    );
  }
  const candles = await fetchOHLCV(apiKey, 30, "1D");
  const vol = computeVolatility(candles, "1D");

  const cells: ConfigResult[] = [];
  for (const width of WIDTHS) {
    for (const fee of FEE_TIERS) {
      const weeks = runBacktest(
        weeklyPrices,
        width.bps,
        fee.rate,
        vol,
      );
      cells.push(
        summarize(weeks, width.label, width.bps, fee.label, fee.rate),
      );
    }
  }

  // Joint breakevens
  const jointBreakevens: FullBacktestResult["jointBreakevens"] = [];
  for (const width of WIDTHS) {
    const joint = findJointBreakeven(weeklyPrices, width.bps, vol);
    const unhedgedBE = findBreakeven(
      weeklyPrices,
      width.bps,
      vol,
      "unhedged",
    );
    jointBreakevens.push({
      widthLabel: width.label,
      widthBps: width.bps,
      minYield: joint.minYield,
      unhedgedBE,
      hedgeCostBps: (joint.minYield - unhedgedBE) * 10_000,
      avgPremiumPerWeek: joint.avgPremiumPerWeek,
      avgPayoutPerWeek: joint.avgPayoutPerWeek,
      lpPnl: joint.lpPnl,
      rtPnl: joint.rtPnl,
    });
  }

  return {
    meta: {
      weeksUsed: weeklyPrices.length - 1,
      dateRange: {
        from: formatDate(weeklyPrices[0].timestamp),
        to: formatDate(weeklyPrices[weeklyPrices.length - 1].timestamp),
      },
      vol,
    },
    cells,
    jointBreakevens,
  };
}

export { WIDTHS, FEE_TIERS, runBacktest, summarize, findBreakeven };
export type { ConfigResult, WeekResult };
