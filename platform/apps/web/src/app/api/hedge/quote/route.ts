/**
 * POST /api/hedge/quote  { owner, positionMint }
 *
 * Issues a Liquidity Hedge certificate quote for one of the owner's
 * Orca Whirlpool positions. The position is located via the same
 * server-side portfolio fetch as /api/portfolio (server-only RPC_URL),
 * must be SOL/USDC and in range; market inputs come from the cached
 * regime snapshot (10-minute TTL, inside regimeMaxAgeSeconds).
 *
 * Responses: 200 quote payload · 400 bad input · 404 position not found
 * · 409 ledger refusal (LedgerError message verbatim) · 503 missing
 * server configuration (treasury / market data).
 */

import { type NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchPortfolio } from "@lh/portfolio";
import {
  buildTermSheet,
  LedgerError,
  type HedgedPositionInput,
} from "@lh/hedge";
import type { HedgeQuoteResponse } from "@/lib/hedge-api";
import { SOL_MINT } from "@/lib/server/birdeye";
import {
  getConsentItems,
  getHedgeConfig,
  HedgeUnavailableError,
  withHedge,
} from "@/lib/server/hedge-ledger";
import { getMarketInputs } from "@/lib/server/hedge-market";

export const dynamic = "force-dynamic";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export async function POST(request: NextRequest) {
  let ownerRaw: unknown;
  let positionMint: unknown;
  try {
    const body = await request.json();
    ownerRaw = body?.owner;
    positionMint = body?.positionMint;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(typeof ownerRaw === "string" ? ownerRaw : "");
  } catch {
    return NextResponse.json(
      { error: "Invalid or missing `owner` — expected a base58 Solana public key." },
      { status: 400 },
    );
  }
  if (typeof positionMint !== "string" || positionMint.trim() === "") {
    return NextResponse.json(
      { error: "Missing `positionMint`." },
      { status: 400 },
    );
  }

  try {
    // Fail fast on missing config before any RPC round-trip.
    const config = getHedgeConfig();

    const connection = new Connection(
      process.env.RPC_URL ?? DEFAULT_RPC_URL,
      "confirmed",
    );
    const views = await fetchPortfolio(connection, owner);
    const view = views.find((v) => v.positionMint === positionMint);
    if (!view) {
      return NextResponse.json(
        { error: "Position not found for this owner." },
        { status: 404 },
      );
    }
    if (view.tokenMintA !== SOL_MINT || !view.isUsdcQuoted) {
      return NextResponse.json(
        { error: "Only SOL/USDC positions can be hedged." },
        { status: 409 },
      );
    }
    if (!view.inRange) {
      return NextResponse.json(
        { error: "Position is out of range — only in-range positions can be hedged." },
        { status: 409 },
      );
    }

    const market = await getMarketInputs(config.tenorSeconds);

    const position: HedgedPositionInput = {
      positionMint: view.positionMint,
      ownerWallet: owner.toBase58(),
      whirlpool: view.whirlpool,
      liquidity: view.liquidity,
      tickLower: view.tickLower,
      tickUpper: view.tickUpper,
      decimalsA: view.decimalsA,
      decimalsB: view.decimalsB,
      currentPriceUsd: view.price, // live pool price at quote time
    };

    const { quote, termSheet } = await withHedge((ledger, cfg) => {
      // Tidy up first so a previously expired quote never blocks re-quoting.
      ledger.lapseExpiredQuotes();
      const issued = ledger.issueQuote(position, market.inputs);
      return { quote: issued, termSheet: buildTermSheet(issued, cfg) };
    });

    const body: HedgeQuoteResponse = {
      quote,
      termSheet,
      termSheetHash: quote.termSheetHash,
      consentItems: getConsentItems(),
      paymentInstructions: {
        treasuryAddress: config.treasuryAddress,
        amountUsdc: quote.totalPayableUsdc,
        memoReference: quote.referenceKey,
        expiresAtTs: quote.validUntilTs,
      },
    };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof HedgeUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof LedgerError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && /must be in range/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Never leak RPC endpoints, provider keys or stack traces to the client.
    console.error("[api/hedge/quote] failure:", error);
    return NextResponse.json(
      { error: "Failed to issue a quote — upstream data unavailable." },
      { status: 502 },
    );
  }
}
