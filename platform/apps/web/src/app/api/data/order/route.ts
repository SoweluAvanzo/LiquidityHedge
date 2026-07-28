/**
 * POST /api/data/order — create a data-product order.
 *
 * Returns the payment instructions (Solana Pay URL + exact amount +
 * reference). No funds move here; the buyer pays from their own wallet
 * and the platform verifies on-chain before delivering anything.
 */
import { type NextRequest, NextResponse } from "next/server";
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { PublicKey } from "@solana/web3.js";
import { buildPaymentRequest, PRODUCTS } from "@lh/commerce";
import {
  commerceConfig,
  CommerceUnavailableError,
  isProductId,
  withOrders,
} from "@/lib/server/order-ledger";
import { datasetCoverage } from "@/lib/server/dataset-coverage";

export const dynamic = "force-dynamic";

function validEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
}

export async function POST(req: NextRequest) {
  // A10: cost-tiered rate limit, keyed on the trusted last hop.
  const limit = checkLimit(req, "order");
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { productId, buyerWallet, email } = (body ?? {}) as Record<string, unknown>;

  if (!isProductId(productId)) {
    return NextResponse.json(
      { error: `Unknown product. Expected one of: ${Object.keys(PRODUCTS).join(", ")}` },
      { status: 400 },
    );
  }
  if (buyerWallet !== undefined && buyerWallet !== null) {
    if (typeof buyerWallet !== "string") {
      return NextResponse.json({ error: "buyerWallet must be a base58 address." }, { status: 400 });
    }
    try {
      new PublicKey(buyerWallet);
    } catch {
      return NextResponse.json({ error: "buyerWallet is not a valid Solana address." }, { status: 400 });
    }
  }
  if (email !== undefined && email !== null && !validEmail(email)) {
    return NextResponse.json({ error: "email is not a valid address." }, { status: 400 });
  }
  // Pre-orders are delivered by hand: an email is the only delivery channel.
  if (PRODUCTS[productId].preOrder && !validEmail(email)) {
    return NextResponse.json(
      { error: "An email address is required for pre-orders (delivery is manual)." },
      { status: 400 },
    );
  }

  const { order, claimSecret } = await withOrders((ledger) =>
    ledger.createOrder({
      productId,
      buyerWallet: (buyerWallet as string) ?? null,
      email: (email as string) ?? null,
    }),
  );
  const payment = buildPaymentRequest(order, config.revenueWallet, config.usdcMint);

  // B1: the covered period and exact row count, quoted BEFORE payment,
  // from the same table the download streams from. Null for pre-orders
  // (nothing collected yet) and when the store cannot answer — the
  // client states "could not be quoted", never an invented figure.
  const coverage = PRODUCTS[productId].preOrder ? null : await datasetCoverage();

  return NextResponse.json({
    orderId: order.orderId,
    coverage,
    // AUDIT #9: returned ONCE, to the creator only. The orderId travels
    // on-chain in the payment memo and is therefore public; this is what
    // proves the caller is the buyer when they come back for the download
    // grant. Never logged, never re-derivable from the ledger.
    claimSecret,
    productId: order.productId,
    productName: PRODUCTS[order.productId].name,
    preOrder: PRODUCTS[order.productId].preOrder,
    amountUsdc: order.amountUsdc,
    expiresAtTs: order.expiresAtTs,
    payment: {
      recipient: payment.recipient,
      reference: payment.reference,
      memo: payment.memo,
      solanaPayUrl: payment.url,
    },
  });
}
