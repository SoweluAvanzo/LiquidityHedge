/**
 * GET /api/hedge/status[?quoteId=…|?positionMint=…]
 *
 * Read-side of the hedge ledger: quote/certificate state for polling
 * plus the FR-A5 monitor summary (net reserves, active exposure,
 * paused flag, invariant report) for the transparency footer.
 *
 * Lookup: `quoteId` returns that quote (404 when unknown);
 * `positionMint` resumes the most relevant quote for a position
 * (active certificate first, then open quote, then latest); with
 * neither, only the monitor summary is returned.
 */

import { type NextRequest, NextResponse } from "next/server";
import type { QuoteRecord } from "@lh/hedge";
import type { HedgeStatusResponse } from "@/lib/hedge-api";
import {
  getConsentItems,
  hedgeDevMode,
  HedgeUnavailableError,
  withHedge,
} from "@/lib/server/hedge-ledger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const quoteId = request.nextUrl.searchParams.get("quoteId");
  const positionMint = request.nextUrl.searchParams.get("positionMint");

  try {
    const result = await withHedge((ledger, config) => {
      // Polling doubles as the lapse sweep — statuses are always current.
      ledger.lapseExpiredQuotes();
      const state = ledger.getState();

      let quote: QuoteRecord | undefined;
      if (quoteId) {
        quote = state.quotes.get(quoteId);
        if (!quote) return { notFound: true as const };
      } else if (positionMint) {
        const candidates = [...state.quotes.values()]
          .filter((q) => q.position.positionMint === positionMint)
          .sort((a, b) => a.issuedAtTs - b.issuedAtTs);
        quote =
          candidates.findLast(
            (q) => state.certs.get(q.quoteId)?.status === "active",
          ) ??
          candidates.findLast((q) => q.status === "open") ??
          candidates.at(-1);
      }
      const certificate = quote ? state.certs.get(quote.quoteId) : undefined;

      const monitor = ledger.monitor();
      const body: HedgeStatusResponse = {
        devMode: hedgeDevMode(),
        treasuryAddress: config.treasuryAddress,
        hasActivity: ledger.getEvents().length > 1,
        monitor: {
          netReservesUsdc: monitor.netReservesUsdc,
          activeExposureUsdc: monitor.activeExposureUsdc,
          paused: monitor.paused,
          invariants: {
            ok: monitor.invariants.ok,
            failures: monitor.invariants.failures,
          },
        },
        consentItems: getConsentItems(),
        ...(quote ? { quote } : {}),
        ...(certificate ? { certificate } : {}),
      };
      return { body };
    });

    if ("notFound" in result) {
      return NextResponse.json({ error: "Unknown quote." }, { status: 404 });
    }
    return NextResponse.json(result.body);
  } catch (error) {
    if (error instanceof HedgeUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[api/hedge/status] failure:", error);
    return NextResponse.json(
      { error: "Failed to read hedge status." },
      { status: 500 },
    );
  }
}
