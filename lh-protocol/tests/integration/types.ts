/**
 * Data collection interfaces for the integration test suite.
 * These structures are populated at each phase and serialized to CSV.
 */

import { PublicKey } from "@solana/web3.js";
import { QuoteBreakdown, TemplateConfig, RegimeSnapshot } from "../../protocol/types";

// ─── Test Configuration ─────────────────────────────────────────────

export interface TestConfig {
  tenorSeconds: number;
  rtDepositUsdc: number;       // micro-USDC
  lpSol: number;               // SOL (float)
  lpUsdc: number;              // USDC (float)
  capUsdc: number;             // micro-USDC
  notionalUsdc: number;        // micro-USDC
  barrierPct: number;          // e.g. 0.95 = 5% below entry
  monitorIntervalS: number;
  tickWidth: number;
  cluster: string;
}

// ─── Monitoring ─────────────────────────────────────────────────────

export interface MonitorSnapshot {
  timestamp: number;
  elapsedS: number;
  solPrice: number;
  positionValueUsd: number;
  holdValueUsd: number;
  ilUsd: number;
  ilPct: number;
  isInRange: boolean;
  tickCurrent: number;
  minutesRemaining: number;
}

// ─── Performance ────────────────────────────────────────────────────

export interface LPPerformance {
  entryPrice: number;
  settlementPrice: number;
  priceChangePct: number;
  positionEntryValueUsd: number;
  positionSettlementValueUsd: number;
  positionPnlUsd: number;
  positionPnlPct: number;
  holdValueUsd: number;
  ilUsd: number;
  ilPct: number;
  premiumPaidUsdc: number;
  premiumPaidUsd: number;
  capUsdc: number;
  barrierPrice: number;
  payoutUsdc: number;
  payoutUsd: number;
  certOutcome: string;         // "SETTLED" | "EXPIRED"
  netHedgedPnlUsd: number;    // positionPnl + payout - premium
  unhedgedPnlUsd: number;     // positionPnl alone
  hedgeBenefitUsd: number;    // hedgedPnl - unhedgedPnl
}

export interface RTPerformance {
  capitalDepositedUsdc: number;
  sharesReceived: number;
  premiumIncomeUsdc: number;
  claimsPaidUsdc: number;
  navPerShareBefore: number;
  navPerShareAfter: number;
  usdcReturnedUsdc: number;
  returnOnCapitalPct: number;
}

// ─── Matchmaking ────────────────────────────────────────────────────

export interface MatchmakingVerification {
  poolUtilizationBeforeBps: number;
  poolUtilizationAfterBps: number;
  premiumBreakdown: QuoteBreakdown;
  templateParams: TemplateConfig;
  regimeParams: RegimeSnapshot;
}

// ─── Simulated Payout ───────────────────────────────────────────────

export interface SimulatedPayout {
  priceUsd: number;
  changePct: number;
  barrierBreached: boolean;
  clPositionLossUsdc: number;
  payoutUsdc: number;
  lpNetPnlUsd: number;
  rtPnlUsd: number;
}

// ─── Cost Tracking ──────────────────────────────────────────────────

export interface CostTracking {
  initialLpSol: number;
  initialRtSol: number;
  initialVaultSol: number;
  finalLpSol: number;
  finalRtSol: number;
  finalVaultSol: number;
  totalSolSpentOnGas: number;
  totalGasCostUsd: number;
}

// ─── Assertions ─────────────────────────────────────────────────────

export interface AssertionResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  message: string;
}

// ─── Cleanup State ──────────────────────────────────────────────────

export interface CleanupState {
  dataDir: string;
  positionMint: string | null;
  positionOpen: boolean;
  nftInVault: boolean;
  positionRegistered: boolean;
  certActive: boolean;
  liquidity: string | null;     // bigint as string
  tickLower: number | null;
  tickUpper: number | null;
}

// ─── Full Results ───────────────────────────────────────────────────

export interface TestResults {
  config: TestConfig;
  startTime: string;
  endTime: string;
  lpPerformance: LPPerformance;
  rtPerformance: RTPerformance;
  matchmaking: MatchmakingVerification;
  monitorSnapshots: MonitorSnapshot[];
  simulatedPayouts: SimulatedPayout[];
  costTracking: CostTracking;
  assertions: AssertionResult[];
}
