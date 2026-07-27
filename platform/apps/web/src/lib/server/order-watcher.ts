/**
 * Revenue-wallet watcher — credits payments that carry no reference key.
 *
 * AUDIT #7. The only detection path was `findVerifiedPayment`, which looks
 * up the Solana Pay **reference account**. An exchange withdrawal cannot
 * attach one (and usually cannot attach a memo either), so a buyer paying
 * exactly as the UI instructed was never credited: the order expired, no
 * file was delivered, no refund was raised, and the money sat in the
 * revenue wallet unaccounted for.
 *
 * This watcher scans the revenue ATA directly and binds an inbound
 * transfer to an order by its EXACT amount. That is sound because
 * `taggedAmount()` already enforces amount uniqueness across every
 * currently-open order (see order-ledger `openAmounts()`), so the mapping
 * amount → order is one-to-one by construction rather than by luck. If
 * that invariant is ever violated the ambiguous transfer is skipped and
 * logged rather than credited to a guess.
 *
 * It is deliberately a CREDITING path only. It never signs, never refunds,
 * and never releases a download grant — `fulfil()` marks the order ready,
 * and the grant is still handed out only against the claim secret
 * (AUDIT #9). A watcher that could both credit and release would let
 * anyone who paid the right amount collect someone else's file.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { verifyPayment, PRODUCTS } from "@lh/commerce";

import { commerceConfig, CommerceUnavailableError, withOrders } from "./order-ledger";
import { serverConnection } from "./payment-lookup";
import { numericEnv } from "@lh/storage";

/** Signatures inspected per cycle. Orders expire long before this rolls. */
const SCAN_LIMIT = 100;

let running = false;

export interface OrderScanReport {
  inspected: number;
  credited: number;
  ambiguous: number;
  openOrders: number;
}

/**
 * One scan pass. Idempotent: the ledger rejects a `txSignature` it has
 * already seen, so re-reading the same window is harmless and the watcher
 * needs no durable cursor.
 */
export async function scanRevenueWalletOnce(): Promise<OrderScanReport> {
  const empty: OrderScanReport = {
    inspected: 0,
    credited: 0,
    ambiguous: 0,
    openOrders: 0,
  };
  if (running) return empty;
  running = true;
  try {
    const config = commerceConfig();

    const open = await withOrders((l) => l.openOrders());
    if (open.length === 0) return { ...empty, openOrders: 0 };

    // Amount → order. Uniqueness is an invariant of taggedAmount(); if it
    // is ever broken we must not guess which order the money was for.
    const byAmount = new Map<number, string[]>();
    for (const o of open) {
      byAmount.set(o.amountUsdc, [...(byAmount.get(o.amountUsdc) ?? []), o.orderId]);
    }

    const connection: Connection = serverConnection();
    const usdcMint = new PublicKey(config.usdcMint);
    const revenueAta = getAssociatedTokenAddressSync(
      usdcMint,
      new PublicKey(config.revenueWallet),
    );
    const revenueAtaStr = revenueAta.toBase58();

    const sigs = await connection.getSignaturesForAddress(
      revenueAta,
      { limit: SCAN_LIMIT },
      "finalized",
    );

    let inspected = 0;
    let credited = 0;
    let ambiguous = 0;

    for (const sig of sigs) {
      if (sig.err) continue; // a failed transaction moved no money
      inspected++;

      const tx = await connection.getParsedTransaction(sig.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      // Try each open order's exact amount. `verifyPayment` re-checks the
      // mint, the recipient account and the credited balance delta, so a
      // match here is a fully verified payment, not an amount coincidence.
      for (const [amountUsdc, orderIds] of byAmount) {
        const result = verifyPayment(tx as never, {
          revenueAta: revenueAtaStr,
          usdcMint: config.usdcMint,
          expectedAmountUsdc: amountUsdc,
        });
        if (!result.ok) continue;

        if (orderIds.length !== 1) {
          ambiguous++;
          console.error(
            `[order-watcher] ${orderIds.length} open orders share amount ` +
              `${amountUsdc} µUSDC (${orderIds.join(", ")}) — tx ${sig.signature} ` +
              `left uncredited rather than assigned to a guess. This should be ` +
              `impossible: taggedAmount() enforces uniqueness across open orders.`,
          );
          break;
        }

        const orderId = orderIds[0];
        const outcome = await withOrders((ledger) => {
          const paid = ledger.observePayment(orderId, {
            txSignature: result.txSignature,
            amountUsdc: result.amountUsdc,
            senderWallet: result.senderWallet,
            slot: result.slot,
            observedAtTs: Math.floor(Date.now() / 1000),
          });
          if (!paid) return "rejected-or-duplicate";
          // Mark deliverable. The download grant itself is NOT released
          // here — it is issued only against the claim secret.
          if (!PRODUCTS[paid.productId].preOrder) ledger.fulfil(orderId);
          return "credited";
        });

        if (outcome === "credited") {
          credited++;
          byAmount.delete(amountUsdc); // one payment per order
          console.log(
            `[order-watcher] credited order ${orderId} from ${sig.signature} ` +
              `(${amountUsdc} µUSDC, no reference key)`,
          );
        }
        break;
      }
    }

    return { inspected, credited, ambiguous, openOrders: open.length };
  } finally {
    running = false;
  }
}

/**
 * Start the resident loop. No-op when data sales are unconfigured, so it
 * is safe to call unconditionally at boot.
 */
export function startOrderWatcher(): void {
  const seconds = numericEnv("ORDER_WATCH_INTERVAL_SECONDS", 30);
  if (seconds <= 0) return;
  try {
    commerceConfig();
  } catch (e) {
    if (e instanceof CommerceUnavailableError) return; // data sales disabled
    throw e;
  }

  const tick = () => {
    scanRevenueWalletOnce()
      .then((r) => {
        if (r.credited > 0 || r.ambiguous > 0) {
          console.log(
            `[order-watcher] open=${r.openOrders} inspected=${r.inspected} ` +
              `credited=${r.credited} ambiguous=${r.ambiguous}`,
          );
        }
      })
      .catch((e) => console.error("[order-watcher] scan failed:", e?.message ?? e))
      .finally(() => setTimeout(tick, seconds * 1000));
  };
  console.log(
    `[order-watcher] watching revenue wallet every ${seconds}s ` +
      `(credits by exact amount; never signs, never releases a grant)`,
  );
  setTimeout(tick, 7_000);
}
