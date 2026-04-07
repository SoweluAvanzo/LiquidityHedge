/**
 * CSV export — writes 3 CSV files to a timestamped output directory.
 */

import * as fs from "fs";
import * as path from "path";
import { MonitorSnapshot, SimulatedPayout, TestResults } from "./types";

export function ensureOutputDir(baseDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(baseDir, `test-results-${timestamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

export function writeMonitorCsv(outDir: string, snapshots: MonitorSnapshot[]): string {
  const filePath = path.join(outDir, "monitor-timeline.csv");
  const header = "timestamp_utc,elapsed_s,sol_price,pos_value_usd,hold_value_usd,il_usd,il_pct,in_range,tick_current,min_remaining";
  const rows = snapshots.map((s) =>
    [
      new Date(s.timestamp * 1000).toISOString(),
      s.elapsedS,
      s.solPrice.toFixed(6),
      s.positionValueUsd.toFixed(10),
      s.holdValueUsd.toFixed(10),
      s.ilUsd.toFixed(10),
      s.ilPct.toFixed(8),
      s.isInRange,
      s.tickCurrent,
      s.minutesRemaining.toFixed(1),
    ].join(",")
  );
  fs.writeFileSync(filePath, [header, ...rows].join("\n"));
  return filePath;
}

export function writeSimulatedPayoutsCsv(outDir: string, payouts: SimulatedPayout[]): string {
  const filePath = path.join(outDir, "simulated-payouts.csv");
  const header = "price_usd,change_pct,barrier_breached,cl_loss_usdc,payout_usdc,lp_net_pnl_usd,rt_pnl_usd";
  const rows = payouts.map((p) =>
    [
      p.priceUsd.toFixed(4),
      p.changePct.toFixed(2),
      p.barrierBreached,
      (p.clPositionLossUsdc / 1e6).toFixed(6),
      (p.payoutUsdc / 1e6).toFixed(6),
      p.lpNetPnlUsd.toFixed(6),
      p.rtPnlUsd.toFixed(6),
    ].join(",")
  );
  fs.writeFileSync(filePath, [header, ...rows].join("\n"));
  return filePath;
}

export function writePerformanceSummaryCsv(outDir: string, results: TestResults): string {
  const filePath = path.join(outDir, "performance-summary.csv");
  const lp = results.lpPerformance;
  const rt = results.rtPerformance;
  const mm = results.matchmaking;
  const cost = results.costTracking;
  const passedAssertions = results.assertions.filter((a) => a.passed).length;

  const header = [
    "test_run_id", "entry_price", "settlement_price", "price_change_pct",
    "pos_entry_usd", "pos_settle_usd", "pos_pnl_usd", "il_pct",
    "premium_usd", "cap_usdc", "barrier_price", "payout_usd", "cert_outcome",
    "hedged_pnl_usd", "unhedged_pnl_usd", "hedge_benefit_usd",
    "rt_capital_usdc", "rt_shares", "rt_premium_usdc", "rt_claims_usdc",
    "rt_nav_before", "rt_nav_after", "rt_returned_usdc", "rt_return_pct",
    "util_before_bps", "util_after_bps",
    "gas_sol", "gas_usd", "assertions_passed", "assertions_total",
  ].join(",");

  const row = [
    results.startTime,
    lp.entryPrice.toFixed(4), lp.settlementPrice.toFixed(4), lp.priceChangePct.toFixed(4),
    lp.positionEntryValueUsd.toFixed(6), lp.positionSettlementValueUsd.toFixed(6),
    lp.positionPnlUsd.toFixed(6), lp.ilPct.toFixed(4),
    lp.premiumPaidUsd.toFixed(6), (lp.capUsdc / 1e6).toFixed(2),
    lp.barrierPrice.toFixed(4), lp.payoutUsd.toFixed(6), lp.certOutcome,
    lp.netHedgedPnlUsd.toFixed(6), lp.unhedgedPnlUsd.toFixed(6), lp.hedgeBenefitUsd.toFixed(6),
    (rt.capitalDepositedUsdc / 1e6).toFixed(2), rt.sharesReceived,
    (rt.premiumIncomeUsdc / 1e6).toFixed(6), (rt.claimsPaidUsdc / 1e6).toFixed(6),
    rt.navPerShareBefore.toFixed(6), rt.navPerShareAfter.toFixed(6),
    (rt.usdcReturnedUsdc / 1e6).toFixed(6), rt.returnOnCapitalPct.toFixed(4),
    mm.poolUtilizationBeforeBps, mm.poolUtilizationAfterBps,
    cost.totalSolSpentOnGas.toFixed(6), cost.totalGasCostUsd.toFixed(4),
    passedAssertions, results.assertions.length,
  ].join(",");

  fs.writeFileSync(filePath, [header, row].join("\n"));
  return filePath;
}
