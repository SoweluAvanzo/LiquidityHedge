/**
 * GET  /api/hedge/quote?owner=&positionMint=  -> single-use challenge
 * POST /api/hedge/quote  { owner, positionMint, nonce, signature }
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
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
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
import {
  issueChallenge,
  challengeMessage,
  verifyWalletProof,
} from "@/lib/server/wallet-auth";

export const dynamic = "force-dynamic";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

/**
 * GET /api/hedge/quote?owner=<base58> — mint a single-use challenge.
 *
 * AUDIT #11: quoting mutates per-owner ledger state (it blocks the
 * position's mint for the quote TTL and consumes the owner's budget), so
 * the caller must prove they control the owner wallet.
 */
export async function GET(request: NextRequest) {
  const limit = checkLimit(request, "quote");
  if (!limit.ok) return tooManyRequests(limit);

  const ownerParam = request.nextUrl.searchParams.get("owner") ?? "";
  const positionMint = request.nextUrl.searchParams.get("positionMint") ?? "";
  let owner: string;
  try {
    owner = new PublicKey(ownerParam).toBase58();
  } catch {
    return NextResponse.json(
      { error: "Invalid or missing `owner` — expected a base58 Solana public key." },
      { status: 400 },
    );
  }
  if (!positionMint.trim()) {
    return NextResponse.json({ error: "Missing `positionMint`." }, { status: 400 });
  }

  const { nonce, expiresAtTs } = issueChallenge(owner);
  return NextResponse.json({
    nonce,
    expiresAtTs,
    message: challengeMessage({ owner, positionMint, nonce }),
  });
}

export async function POST(request: NextRequest) {
  // A10: cost-tiered rate limit, keyed on the trusted last hop. (This call
  // was missing while the import was present — quote and simulate are the
  // two most expensive routes, so leaving them unguarded defeated the fix.)
  const limit = checkLimit(request, "quote");
  if (!limit.ok) return tooManyRequests(limit);
  let ownerRaw: unknown;
  let positionMint: unknown;
  let nonce: unknown;
  let signature: unknown;
  try {
    const body = await request.json();
    ownerRaw = body?.owner;
    positionMint = body?.positionMint;
    nonce = body?.nonce;
    signature = body?.signature;
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

  // AUDIT #11: prove control of `owner` before touching the ledger. Done
  // before any RPC round-trip so an unauthenticated caller costs us
  // nothing but a signature check.
  const proof = verifyWalletProof({
    owner: owner.toBase58(),
    positionMint,
    nonce,
    signature,
  });
  if (!proof.ok) {
    return NextResponse.json({ error: proof.reason }, { status: proof.status });
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
