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
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { QuoteRecord } from "@lh/hedge";
import type { HedgeStatusResponse } from "@/lib/hedge-api";
import {
  getConsentItems,
  hedgeDevMode,
  HedgeUnavailableError,
  withHedge,
} from "@/lib/server/hedge-ledger";

export const dynamic = "force-dynamic";

/** C4 tolerance: ledger vs chain may differ by in-flight payouts for a
 *  short window; 1 USDC of slack, beyond that it is a failure. */
const RESERVE_TOLERANCE_USDC = 1_000_000;

/**
 * C4: read the treasury's USDC ATA at finalized commitment. Returns the
 * balance in µUSDC; 0 when the ATA does not exist (an empty treasury IS
 * zero, not unknown); null when the chain could not be read.
 */
async function readTreasuryOnChainUsdc(
  treasuryAddress: string,
): Promise<number | null> {
  try {
    const connection = new Connection(
      process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
      "finalized",
    );
    const usdcMint = new PublicKey(
      process.env.USDC_MINT?.trim() || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // "" = unset (audit 0.1)
    );
    const ata = getAssociatedTokenAddressSync(
      usdcMint,
      new PublicKey(treasuryAddress),
    );
    const info = await connection.getAccountInfo(ata, "finalized");
    if (!info) return 0;
    const bal = await connection.getTokenAccountBalance(ata, "finalized");
    return Number(bal.value.amount);
  } catch (error) {
    console.error(
      "[api/hedge/status] treasury chain read failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function GET(request: NextRequest) {
  // A10: cost-tiered rate limit, keyed on the trusted last hop.
  const limit = checkLimit(request, "status");
  if (!limit.ok) return tooManyRequests(limit);
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
            failures: [...monitor.invariants.failures],
          },
          reserves: {
            ledgerUsdc: monitor.netReservesUsdc,
            onChainUsdc: null, // filled below, outside the ledger lock
            deltaUsdc: null,
            reconciled: null,
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

    // C4: reconcile the ledger's reserve figure against the chain. The
    // ledger checking its own arithmetic can never notice a funding
    // shortfall; the ATA read can. In dev mode the ledger is seeded with
    // synthetic reserves, so the check is skipped and stays "unverified".
    if (!hedgeDevMode()) {
      const onChain = await readTreasuryOnChainUsdc(result.body.treasuryAddress);
      const r = result.body.monitor.reserves;
      r.onChainUsdc = onChain;
      if (onChain !== null) {
        r.deltaUsdc = onChain - r.ledgerUsdc;
        r.reconciled = Math.abs(r.deltaUsdc) <= RESERVE_TOLERANCE_USDC;
        if (!r.reconciled) {
          result.body.monitor.invariants.ok = false;
          result.body.monitor.invariants.failures.push(
            `C4: on-chain treasury balance ${(onChain / 1e6).toFixed(2)} USDC ` +
              `diverges from ledger reserves ${(r.ledgerUsdc / 1e6).toFixed(2)} ` +
              `USDC by ${(Math.abs(r.deltaUsdc) / 1e6).toFixed(2)}`,
          );
        }
      }
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
