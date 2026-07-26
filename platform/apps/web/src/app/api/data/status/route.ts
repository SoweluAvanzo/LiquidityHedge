/**
 * GET /api/data/status?orderId=… — order state, and (while awaiting
 * payment) a live on-chain check via the Solana Pay reference.
 *
 * Delivery is granted ONLY from verified chain state. A client cannot
 * assert payment; it can only ask us to look again.
 */
import { type NextRequest, NextResponse } from "next/server";
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { PRODUCTS } from "@lh/commerce";
import { commerceConfig, CommerceUnavailableError, withOrders } from "@/lib/server/order-ledger";
import { findVerifiedPayment, serverConnection } from "@/lib/server/payment-lookup";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // A10: cost-tiered rate limit, keyed on the trusted last hop.
  const limit = checkLimit(req, "status");
  if (!limit.ok) return tooManyRequests(limit);
  let config;
  try {
    config = commerceConfig();
  } catch (e) {
    if (e instanceof CommerceUnavailableError) {
      return NextResponse.json({ error: "Data sales are not configured." }, { status: 503 });
    }
    throw e;
  }

  const orderId = req.nextUrl.searchParams.get("orderId");
  if (!orderId || !/^[a-f0-9]{4,64}$/i.test(orderId)) {
    return NextResponse.json({ error: "Invalid orderId." }, { status: 400 });
  }

  const order = await withOrders((l) => l.getOrder(orderId));
  if (!order) return NextResponse.json({ error: "Unknown order." }, { status: 404 });

  let note: string | null = null;
  let downloadToken: string | null = null;

  if (order.status === "awaiting-payment") {
    try {
      const lookup = await findVerifiedPayment({
        connection: serverConnection(),
        reference: order.reference,
        revenueWallet: config.revenueWallet,
        usdcMint: config.usdcMint,
        expectedAmountUsdc: order.amountUsdc,
      });
      if (lookup.found && lookup.verified?.ok) {
        const v = lookup.verified;
        const result = await withOrders((ledger) => {
          const paid = ledger.observePayment(orderId, {
            txSignature: v.txSignature,
            amountUsdc: v.amountUsdc,
            senderWallet: v.senderWallet,
            slot: v.slot,
            observedAtTs: Math.floor(Date.now() / 1000),
          });
          if (paid && !PRODUCTS[paid.productId].preOrder) {
            return ledger.fulfil(orderId).downloadToken;
          }
          return null;
        });
        downloadToken = result;
      } else if (lookup.candidates > 0 && lookup.verified && !lookup.verified.ok) {
        note = `A transaction was found but did not pass verification: ${lookup.verified.reason}`;
      }
    } catch (e) {
      console.error("[api/data/status] chain lookup failed:", e);
      note = "Could not reach the chain to verify payment. Try again shortly.";
    }
  }

  const fresh = await withOrders((l) => l.getOrder(orderId))!;
  return NextResponse.json({
    orderId,
    status: fresh?.status ?? order.status,
    preOrder: PRODUCTS[order.productId].preOrder,
    amountUsdc: order.amountUsdc,
    expiresAtTs: order.expiresAtTs,
    // Returned exactly once, at the moment of fulfilment.
    downloadToken,
    downloadExpiresAtTs: fresh?.downloadExpiresAtTs ?? null,
    note,
  });
}
