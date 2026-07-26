/**
 * Treasury payment watcher: incremental, cursor-based scan of the treasury
 * USDC ATA for finalized inbound transfers. Feeding the results into
 * `CertificateLedger.observePayment` is idempotent by construction
 * (txSignature key), so overlapping scans are harmless.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { ObservedTransfer } from "../types";
import { extractUsdcPayment } from "./payment-parse";

export interface ScanResult {
  transfers: ObservedTransfer[];
  /** Pass as `untilSignature` on the next scan (newest seen this scan). */
  cursor: string | null;
}

export async function scanTreasuryPayments(
  connection: Connection,
  treasuryAta: PublicKey,
  usdcMint: PublicKey,
  opts?: { untilSignature?: string; limit?: number },
): Promise<ScanResult> {
  const sigInfos = await connection.getSignaturesForAddress(
    treasuryAta,
    { until: opts?.untilSignature, limit: opts?.limit ?? 200 },
    "finalized",
  );
  if (sigInfos.length === 0) return { transfers: [], cursor: opts?.untilSignature ?? null };

  const txs = await connection.getParsedTransactions(
    sigInfos.map((s) => s.signature),
    { commitment: "finalized", maxSupportedTransactionVersion: 0 },
  );

  const params = {
    treasuryAta: treasuryAta.toBase58(),
    usdcMint: usdcMint.toBase58(),
  };
  const transfers: ObservedTransfer[] = [];
  for (const tx of txs) {
    if (!tx) continue; // pruned by RPC — the next scan window will retry
    const transfer = extractUsdcPayment(tx, params);
    if (transfer) transfers.push(transfer);
  }
  // Oldest-first so the ledger sees payments in chain order.
  transfers.reverse();
  return { transfers, cursor: sigInfos[0].signature };
}
