/**
 * POST /api/hedge/dev/settle-due
 *
 * DEV ONLY (404 unless HEDGE_DEV_MODE === "1"): the settler worker in
 * miniature. For every certificate past expiry it reads the CURRENT
 * live pool price from the position's whirlpool account (decimals-safe)
 * and settles with a zero-divergence reading and zero accrued fees —
 * Master Terms §7.2 amount, invariants re-checked by the ledger.
 */

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { LedgerError } from "@lh/hedge";
import {
  decodeWhirlpoolAccount,
  sqrtPriceX64ToPrice,
} from "@lh/core/src/market-data/decoder";
import type { HedgeSettleResult } from "@/lib/hedge-api";
import {
  hedgeDevMode,
  HedgeUnavailableError,
  withHedge,
} from "@/lib/server/hedge-ledger";

export const dynamic = "force-dynamic";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export async function POST() {
  if (!hedgeDevMode()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    // Pass 1 (mutex): which certificates are due, and in which pools.
    const due = await withHedge((ledger) => {
      ledger.lapseExpiredQuotes();
      return ledger.dueForSettlement().map((cert) => {
        const quote = ledger.getState().quotes.get(cert.quoteId)!;
        return {
          quoteId: cert.quoteId,
          whirlpool: quote.position.whirlpool,
          decimalsA: quote.position.decimalsA,
          decimalsB: quote.position.decimalsB,
        };
      });
    });
    if (due.length === 0) {
      return NextResponse.json({ settled: [], errors: [] });
    }

    // Live pool prices — read outside the mutex (network I/O).
    const connection = new Connection(
      process.env.RPC_URL ?? DEFAULT_RPC_URL,
      "confirmed",
    );
    const priceByPool = new Map<string, number>();
    for (const d of due) {
      if (priceByPool.has(d.whirlpool)) continue;
      const info = await connection.getAccountInfo(new PublicKey(d.whirlpool));
      if (!info) continue;
      const pool = decodeWhirlpoolAccount(info.data);
      priceByPool.set(
        d.whirlpool,
        sqrtPriceX64ToPrice(pool.sqrtPrice, d.decimalsA, d.decimalsB),
      );
    }

    // Pass 2 (mutex): settle each due certificate at its live price.
    const { settled, errors } = await withHedge((ledger) => {
      const results: HedgeSettleResult[] = [];
      const failures: { quoteId: string; error: string }[] = [];
      for (const d of due) {
        const priceUsd = priceByPool.get(d.whirlpool);
        if (priceUsd === undefined) {
          failures.push({ quoteId: d.quoteId, error: "pool price unavailable" });
          continue;
        }
        try {
          const paid = ledger.settle(
            d.quoteId,
            { priceUsd, slot: 0, crossCheckPriceUsd: priceUsd, divergenceBps: 0 },
            0, // feesAccruedUsdc — dev harness reads no fee growth
          );
          const cert = ledger.getState().certs.get(d.quoteId)!;
          results.push({
            quoteId: d.quoteId,
            priceUsd,
            payoffUsdc: cert.settlement!.payoffUsdc,
            feeSplitUsdc: cert.settlement!.feeSplitUsdc,
            settlementAmountUsdc: paid.settlementAmountUsdc,
            to: paid.to,
            finalStatus: cert.status as "settled" | "expired",
          });
        } catch (error) {
          failures.push({
            quoteId: d.quoteId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { settled: results, errors: failures };
    });

    return NextResponse.json({ settled, errors });
  } catch (error) {
    if (error instanceof HedgeUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof LedgerError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/hedge/dev/settle-due] failure:", error);
    return NextResponse.json(
      { error: "Failed to settle due certificates." },
      { status: 500 },
    );
  }
}
