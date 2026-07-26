/**
 * Settlement runner — one auditable cycle of the production money loop:
 *
 *   scan payments → observe/activate (idempotent) → lapse stale quotes →
 *   settle due certificates (oracle divergence guard, AR-7) → execute
 *   payouts (float-capped, SR-8) → refund sweep.
 *
 * Pure orchestration over ports: no RPC types, no keys. The chain adapters
 * (scanTreasuryPayments, buildPayoutInstructions) implement the ports in
 * ops-jobs/web; tests drive fakes. Payout execution is at-least-once:
 * a payout that fails AFTER its ledger transition is reported in
 * `failedPayouts` for the ops retry queue (RB-2) — the reconciliation
 * monitor (I3 vs on-chain balance) catches anything that slips.
 */

import { CertificateLedger } from "./ledger";
import {
  CertificateRecord,
  LedgerError,
  ObservedTransfer,
  SettlementPriceReading,
} from "./types";

export interface RunnerPorts {
  scanPayments(
    untilSignature: string | null,
  ): Promise<{ transfers: ObservedTransfer[]; cursor: string | null }>;
  readSettlementPrice(cert: CertificateRecord): Promise<SettlementPriceReading>;
  /** Accrued LP fees in µUSDC; implementations MUST return 0 on data
   *  failure (buyer-favorable, Master Terms §7.2). */
  readAccruedFees(cert: CertificateRecord): Promise<number>;
  executePayout(payout: {
    to: string;
    amountUsdc: number;
    memo: string;
  }): Promise<{ txSignature: string }>;
  hotWalletBalanceUsdc(): Promise<number>;
}

export interface RunnerConfig {
  /** Refuse to pay out beyond this per cycle (hot-wallet float, SR-8). */
  hotWalletFloatCapUsdc: number;
  /** Oracle divergence beyond this defers settlement (AR-7). */
  maxDivergenceBps: number;
  /** Plan everything, execute nothing on-chain. */
  dryRun: boolean;
}

export interface PayoutRecord {
  kind: "settlement" | "refund";
  reference: string; // quoteId or payment txSignature
  to: string;
  amountUsdc: number;
  executedTx: string | null; // null in dryRun or when amount is 0
}

export interface CycleReport {
  observedPayments: number;
  activated: string[]; // quoteIds
  lapsedQuotes: number;
  settled: PayoutRecord[];
  refunded: PayoutRecord[];
  deferredForDivergence: { quoteId: string; divergenceBps: number }[];
  failedPayouts: { record: PayoutRecord; error: string }[];
  /** Set when planned payouts exceeded the float — payouts halted (RB-2). */
  floatShortfallUsdc: number | null;
  cursor: string | null;
  invariantsOk: boolean;
}

export async function runSettlementCycle(
  ledger: CertificateLedger,
  ports: RunnerPorts,
  config: RunnerConfig,
  cursor: string | null,
): Promise<CycleReport> {
  const report: CycleReport = {
    observedPayments: 0,
    activated: [],
    lapsedQuotes: 0,
    settled: [],
    refunded: [],
    deferredForDivergence: [],
    failedPayouts: [],
    floatShortfallUsdc: null,
    cursor,
    invariantsOk: true,
  };

  // 1. Payments in (idempotent on txSignature — overlap-safe).
  const scan = await ports.scanPayments(cursor);
  report.cursor = scan.cursor;
  for (const transfer of scan.transfers) {
    const res = ledger.observePayment(transfer);
    if (res.accepted) report.observedPayments++;
    if (res.activated) report.activated.push(res.activated.quoteId);
  }

  // 2. Housekeeping.
  report.lapsedQuotes = ledger.lapseExpiredQuotes();

  // 3. Settlements due.
  const pendingPayouts: PayoutRecord[] = [];
  for (const cert of ledger.dueForSettlement()) {
    const reading = await ports.readSettlementPrice(cert);
    if (reading.divergenceBps > config.maxDivergenceBps) {
      report.deferredForDivergence.push({
        quoteId: cert.quoteId,
        divergenceBps: reading.divergenceBps,
      });
      continue; // AR-7: defer, do not settle on a disputed price
    }
    const fees = await ports.readAccruedFees(cert);
    const { settlementAmountUsdc, to } = ledger.settle(cert.quoteId, reading, fees);
    pendingPayouts.push({
      kind: "settlement",
      reference: cert.quoteId,
      to,
      amountUsdc: settlementAmountUsdc,
      executedTx: null,
    });
  }

  // 4. Refund sweep (wrong-amount / lapsed / unmatched payments).
  for (const [sig, payment] of ledger.getState().paymentsByTx) {
    if (payment.matched) continue;
    try {
      const { amountUsdc, to } = ledger.refundPayment(sig);
      pendingPayouts.push({
        kind: "refund",
        reference: sig,
        to,
        amountUsdc,
        executedTx: null,
      });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e; // "still matchable" is fine
    }
  }

  // 5. Execute payouts under the float cap.
  const toPay = pendingPayouts.filter((p) => p.amountUsdc > 0);
  const totalDue = toPay.reduce((s, p) => s + p.amountUsdc, 0);
  const balance = await ports.hotWalletBalanceUsdc();
  if (totalDue > Math.min(balance, config.hotWalletFloatCapUsdc)) {
    // Halt: ops must top up from the vault (RB-2). Ledger transitions are
    // already recorded; the reconciliation monitor tracks the gap.
    report.floatShortfallUsdc = totalDue - Math.min(balance, config.hotWalletFloatCapUsdc);
  } else if (!config.dryRun) {
    for (const payout of toPay) {
      try {
        const { txSignature } = await ports.executePayout({
          to: payout.to,
          amountUsdc: payout.amountUsdc,
          memo: `${payout.kind === "settlement" ? "settle" : "refund"}:${payout.reference}`,
        });
        payout.executedTx = txSignature;
      } catch (e) {
        report.failedPayouts.push({
          record: payout,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  report.settled = pendingPayouts.filter((p) => p.kind === "settlement");
  report.refunded = pendingPayouts.filter((p) => p.kind === "refund");

  report.invariantsOk = ledger.monitor().invariants.ok;
  return report;
}
