/**
 * GET /api/portfolio?owner=<base58 pubkey>
 *
 * Server-side portfolio snapshot: discovers the owner's Orca Whirlpool
 * positions over RPC (server-only RPC_URL, so provider keys never reach the
 * browser), aggregates a summary and attaches a 101-point V(S) value curve
 * per position for charting.
 *
 * Read-only: this route only reads public on-chain state; it never holds or
 * requests key material.
 */

import { type NextRequest, NextResponse } from "next/server";
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchPortfolio,
  aggregatePortfolio,
  buildValueCurve,
  type PortfolioPositionView,
} from "@lh/portfolio";
import {
  decodeWhirlpoolAccount,
  type WhirlpoolData,
} from "@lh/core/src/market-data/decoder";
import type {
  PortfolioPositionWire,
  PortfolioResponse,
  PositionViabilityWire,
} from "@/lib/portfolio-api";
import { SOL_MINT } from "@/lib/server/birdeye";
import {
  computePositionViability,
  loadViabilityInputs,
} from "@/lib/server/viability";
import { recordPositionObservations } from "@/lib/server/position-yield";

// Every response is a live RPC snapshot — never cache.
export const dynamic = "force-dynamic";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const CURVE_POINTS = 101;


/**
 * Viability Index per SOL/USDC position (FR-M8). Positions keyed by
 * address; any pipeline failure yields null for that position —
 * "viability unavailable" is shown, a value is never faked.
 */
async function computeViabilities(
  connection: Connection,
  views: PortfolioPositionView[],
): Promise<Map<string, PositionViabilityWire | null>> {
  const result = new Map<string, PositionViabilityWire | null>();
  const eligible = views.filter(
    (v) => v.tokenMintA === SOL_MINT && v.isUsdcQuoted,
  );
  if (eligible.length === 0) return result;

  const viabilityInputs = await loadViabilityInputs();
  if (!viabilityInputs) {
    for (const v of eligible) result.set(v.positionAddress, null);
    return result;
  }

  // Decode each distinct whirlpool once: feeRate (ppm) + active liquidity
  // are needed for the fee-yield measurement and are not part of the view.
  const poolKeys = [...new Set(eligible.map((v) => v.whirlpool))];
  const pools = new Map<string, WhirlpoolData>();
  try {
    const infos = await connection.getMultipleAccountsInfo(
      poolKeys.map((k) => new PublicKey(k)),
    );
    poolKeys.forEach((key, i) => {
      const info = infos[i];
      if (!info) return;
      try {
        pools.set(key, decodeWhirlpoolAccount(info.data));
      } catch {
        // Undecodable pool → viability stays unavailable for its positions.
      }
    });
  } catch (error) {
    console.error("[api/portfolio] whirlpool refetch failed:", error);
  }

  for (const view of eligible) {
    const pool = pools.get(view.whirlpool);
    result.set(
      view.positionAddress,
      pool ? await computePositionViability(view, pool, viabilityInputs) : null,
    );
  }
  return result;
}

export async function GET(request: NextRequest) {
  // A10: shared limiter keyed on the trusted last hop. (The previous
  // per-route bucket keyed on the client-controlled first X-Forwarded-For
  // entry, so rotating that header bypassed it entirely.)
  const limit = checkLimit(request, "portfolio");
  if (!limit.ok) return tooManyRequests(limit);

  const ownerParam = request.nextUrl.searchParams.get("owner");
  let owner: PublicKey;
  try {
    owner = new PublicKey(ownerParam ?? "");
  } catch {
    return NextResponse.json(
      { error: "Invalid or missing `owner` — expected a base58 Solana public key." },
      { status: 400 },
    );
  }

  try {
    const connection = new Connection(
      process.env.RPC_URL ?? DEFAULT_RPC_URL,
      "confirmed",
    );
    const views = await fetchPortfolio(connection, owner);
    const summary = aggregatePortfolio(views);
    // §1.2: register served positions for collector tracking and persist
    // their feeGrowthInside as an opportunistic snapshot (best-effort —
    // errors are swallowed inside, never breaking the response).
    await recordPositionObservations(views);
    const viabilities = await computeViabilities(connection, views);

    const positions: PortfolioPositionWire[] = views.map((view) => ({
      ...view,
      liquidity: view.liquidity.toString(),
      amountA: view.amountA.toString(),
      amountB: view.amountB.toString(),
      feesAreExact: view.feesAreExact === true,
      feeOwedA: view.feeOwedA.toString(),
      feeOwedB: view.feeOwedB.toString(),
      curve: buildValueCurve(view, { points: CURVE_POINTS }),
      viability: viabilities.get(view.positionAddress) ?? null,
    }));

    const body: PortfolioResponse = {
      asOf: new Date().toISOString(),
      summary,
      positions,
    };
    return NextResponse.json(body);
  } catch (error) {
    // Never leak RPC endpoints, provider keys or stack traces to the client.
    console.error("[api/portfolio] upstream failure:", error);
    return NextResponse.json(
      { error: "Failed to fetch portfolio from the RPC provider." },
      { status: 502 },
    );
  }
}
