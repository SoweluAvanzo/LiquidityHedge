/**
 * Terminal report formatting for integration test results.
 */

import { TestResults, SimulatedPayout, AssertionResult } from "./types";

export function printReport(results: TestResults): void {
  const lp = results.lpPerformance;
  const rt = results.rtPerformance;
  const mm = results.matchmaking;
  const cost = results.costTracking;

  console.log();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        LIQUIDITY HEDGE PROTOCOL — INTEGRATION TEST REPORT    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // ─── Price ────────────────────────────────────────────────────
  console.log(`SOL Price:  Entry=$${lp.entryPrice.toFixed(6)}  Settlement=$${lp.settlementPrice.toFixed(6)}  Change=${lp.priceChangePct >= 0 ? "+" : ""}${lp.priceChangePct.toFixed(6)}%`);
  console.log();

  // ─── LP Performance ───────────────────────────────────────────
  console.log("── LP Performance (Risk-Averse) ──");
  console.log(`  Position entry:    $${lp.positionEntryValueUsd.toFixed(8)}`);
  console.log(`  Position settle:   $${lp.positionSettlementValueUsd.toFixed(8)}`);
  console.log(`  Position PnL:      ${f(lp.positionPnlUsd)}`);
  console.log(`  IL:                $${lp.ilUsd.toFixed(8)} (${lp.ilPct.toFixed(6)}%)`);
  console.log(`  Premium paid:      $${lp.premiumPaidUsd.toFixed(6)}`);
  console.log(`  Cap:               $${(lp.capUsdc / 1e6).toFixed(6)}`);
  console.log(`  Barrier:           $${lp.barrierPrice.toFixed(6)}`);
  console.log(`  Payout:            $${lp.payoutUsd.toFixed(8)}  [${lp.certOutcome}]`);
  console.log(`  Hedged net PnL:    ${f(lp.netHedgedPnlUsd)}`);
  console.log(`  Unhedged PnL:      ${f(lp.unhedgedPnlUsd)}`);
  console.log(`  Hedge benefit:     ${f(lp.hedgeBenefitUsd)}`);
  console.log();

  // ─── RT Performance ───────────────────────────────────────────
  console.log("── RT Performance (Risk-Taker) ──");
  console.log(`  Capital deposited: $${(rt.capitalDepositedUsdc / 1e6).toFixed(6)}`);
  console.log(`  Shares received:   ${rt.sharesReceived}`);
  console.log(`  Premium income:    $${(rt.premiumIncomeUsdc / 1e6).toFixed(6)}`);
  console.log(`  Claims paid:       $${(rt.claimsPaidUsdc / 1e6).toFixed(6)}`);
  console.log(`  NAV/share:         ${rt.navPerShareBefore.toFixed(8)} → ${rt.navPerShareAfter.toFixed(8)}`);
  console.log(`  USDC returned:     $${(rt.usdcReturnedUsdc / 1e6).toFixed(6)}`);
  console.log(`  Return on capital: ${rt.returnOnCapitalPct >= 0 ? "+" : ""}${rt.returnOnCapitalPct.toFixed(6)}%`);
  console.log();

  // ─── Matchmaking ──────────────────────────────────────────────
  console.log("── Matchmaking Verification ──");
  console.log(`  Pool utilization:  ${mm.poolUtilizationBeforeBps} → ${mm.poolUtilizationAfterBps} bps`);
  const pb = mm.premiumBreakdown;
  console.log(`  Premium breakdown:`);
  console.log(`    E[Payout]:       $${(pb.expectedPayoutUsdc / 1e6).toFixed(6)}`);
  console.log(`    Capital charge:  $${(pb.capitalChargeUsdc / 1e6).toFixed(6)}`);
  console.log(`    Adverse sel.:    $${(pb.adverseSelectionUsdc / 1e6).toFixed(6)}`);
  console.log(`    Replication:     $${(pb.replicationCostUsdc / 1e6).toFixed(6)}`);
  console.log(`    Total premium:   $${(pb.premiumUsdc / 1e6).toFixed(6)}`);
  console.log();

  // ─── Simulated Payout Curve ───────────────────────────────────
  console.log("── Simulated Payout Curve ──");
  console.log("  Price       Change   Barrier  CL Loss    Payout     LP Net PnL  RT PnL");
  for (const p of results.simulatedPayouts) {
    const flag = p.barrierBreached ? "BELOW" : p.changePct <= 0 ? "ABOVE" : "     ";
    console.log(
      `  $${p.priceUsd.toFixed(2).padStart(8)} ${(p.changePct >= 0 ? "+" : "") + p.changePct.toFixed(1) + "%"}`.padEnd(24) +
      `${flag.padEnd(8)}` +
      `$${(p.clPositionLossUsdc / 1e6).toFixed(4).padStart(8)} ` +
      `$${(p.payoutUsdc / 1e6).toFixed(4).padStart(8)} ` +
      `${f(p.lpNetPnlUsd).padStart(12)} ` +
      `${f(p.rtPnlUsd).padStart(10)}`
    );
  }
  console.log();

  // ─── Cost Summary ─────────────────────────────────────────────
  console.log("── Cost Summary ──");
  console.log(`  SOL spent on gas:  ${cost.totalSolSpentOnGas.toFixed(6)} SOL ($${cost.totalGasCostUsd.toFixed(2)})`);
  console.log();

  // ─── Assertions ───────────────────────────────────────────────
  const passed = results.assertions.filter((a) => a.passed).length;
  const total = results.assertions.length;
  console.log(`── Assertions: ${passed}/${total} passed ──`);
  for (const a of results.assertions) {
    const icon = a.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${a.name}`);
    if (!a.passed) console.log(`         ${a.message}`);
  }
  console.log();
}

function f(n: number): string {
  return `${n >= 0 ? "+" : ""}$${n.toFixed(8)}`;
}
