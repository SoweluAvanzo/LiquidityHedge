/**
 * POST /api/hedge/dev/simulate-payment  { quoteId }
 *
 * DEV ONLY (404 unless HEDGE_DEV_MODE === "1"): fabricates the exact
 * finalized USDC transfer the quote expects — correct reference key,
 * exact Premium + Collateral amount, sender = the quoted owner wallet —
 * and feeds it to the ledger's observePayment, which activates the
 * certificate. Stands in for the on-chain payment watcher during local
 * runs; never enabled in production.
 */

import { randomUUID } from "crypto";
import { type NextRequest, NextResponse } from "next/server";
import { LedgerError } from "@lh/hedge";
import {
  hedgeDevMode,
  HedgeUnavailableError,
  withHedge,
} from "@/lib/server/hedge-ledger";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!hedgeDevMode()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let quoteId: unknown;
  try {
    quoteId = (await request.json())?.quoteId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof quoteId !== "string" || quoteId.trim() === "") {
    return NextResponse.json({ error: "Missing `quoteId`." }, { status: 400 });
  }

  try {
    const result = await withHedge((ledger) => {
      ledger.lapseExpiredQuotes();
      const quote = ledger.getState().quotes.get(quoteId);
      if (!quote) return { notFound: true as const };
      if (quote.status !== "open") {
        throw new LedgerError(
          `quote is ${quote.status} — cannot simulate a payment for it`,
        );
      }
      return {
        outcome: ledger.observePayment({
          txSignature: `dev-${randomUUID()}`,
          referenceKey: quote.referenceKey,
          senderWallet: quote.position.ownerWallet,
          amountUsdc: quote.totalPayableUsdc,
        }),
      };
    });

    if ("notFound" in result) {
      return NextResponse.json({ error: "Unknown quote." }, { status: 404 });
    }
    return NextResponse.json({
      accepted: result.outcome.accepted,
      activated: result.outcome.activated ?? null,
    });
  } catch (error) {
    if (error instanceof HedgeUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof LedgerError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/hedge/dev/simulate-payment] failure:", error);
    return NextResponse.json(
      { error: "Failed to simulate payment." },
      { status: 500 },
    );
  }
}
