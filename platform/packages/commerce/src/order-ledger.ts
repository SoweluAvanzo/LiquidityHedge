/**
 * Order ledger: create → observe verified payment → fulfil, exactly once.
 * Pure and event-sourced (same discipline as the certificate ledger), so a
 * restart replays to the identical state and a payment can never be
 * credited twice.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  CommerceConfig,
  Order,
  OrderError,
  OrderStatus,
  PaymentProof,
  PRODUCTS,
  ProductId,
} from "./types";
import { createReference, taggedAmount } from "./payment";

export type OrderEvent =
  | { kind: "OrderCreated"; ts: number; order: Order }
  | { kind: "PaymentObserved"; ts: number; orderId: string; payment: PaymentProof }
  | { kind: "OrderFulfilled"; ts: number; orderId: string; downloadToken: string; expiresAtTs: number }
  | { kind: "OrderExpired"; ts: number; orderId: string }
  | {
      kind: "RefundDue";
      ts: number;
      orderId: string;
      reason: string;
      txSignature?: string;
      /** Who paid and how much — required to actually issue the refund. */
      payment?: PaymentProof;
    };

export interface Clock {
  now(): number;
}

export class OrderLedger {
  private orders = new Map<string, Order>();
  /** Payment idempotency: one signature can credit at most one order. */
  private usedSignatures = new Set<string>();
  private events: OrderEvent[] = [];

  constructor(
    private readonly config: CommerceConfig,
    private readonly clock: Clock,
    private readonly idGen: () => string = () => randomBytes(9).toString("hex"),
  ) {}

  getEvents(): readonly OrderEvent[] {
    return this.events;
  }
  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }
  findByReference(reference: string): Order | undefined {
    for (const o of this.orders.values()) if (o.reference === reference) return o;
    return undefined;
  }
  /** Orders still payable — what the watcher polls for. */
  openOrders(): Order[] {
    const now = this.clock.now();
    return [...this.orders.values()].filter(
      (o) => o.status === "awaiting-payment" && now <= o.expiresAtTs,
    );
  }

  private commit(e: OrderEvent): void {
    this.events.push(structuredClone(e));
  }

  /** Amounts currently claimed by payable orders (tag-collision guard). */
  private openAmounts(): Set<number> {
    const now = this.clock.now();
    const set = new Set<number>();
    for (const o of this.orders.values()) {
      if (o.status === "awaiting-payment" && now <= o.expiresAtTs) set.add(o.amountUsdc);
    }
    return set;
  }

  createOrder(params: {
    productId: ProductId;
    buyerWallet?: string | null;
    email?: string | null;
  }): { order: Order; claimSecret: string } {
    const product = PRODUCTS[params.productId];
    if (!product) throw new OrderError(`unknown product ${params.productId}`);
    const now = this.clock.now();
    const orderId = this.idGen();
    // Returned once to the creator; only its hash is ever stored.
    const claimSecret = randomBytes(24).toString("base64url");
    const order: Order = {
      orderId,
      productId: product.id,
      // Unique micro-cents make manual (memo-less) payments identifiable;
      // uniqueness is enforced against every currently-open order.
      amountUsdc: taggedAmount(product.priceUsdc, this.openAmounts()),
      reference: createReference(),
      buyerWallet: params.buyerWallet ?? null,
      email: params.email ?? null,
      createdAtTs: now,
      expiresAtTs: now + this.config.orderTtlSeconds,
      status: "awaiting-payment",
      claimHash: createHash("sha256").update(claimSecret).digest("hex"),
    };
    this.orders.set(orderId, order);
    this.commit({ kind: "OrderCreated", ts: now, order });
    return { order, claimSecret };
  }

  /**
   * Constant-time check of an order's claim secret.
   *
   * Constant-time because unlike the download token (24 random bytes, no
   * useful timing oracle) this is checked repeatedly during polling.
   */
  verifyClaim(orderId: string, rawClaim: string): boolean {
    const order = this.orders.get(orderId);
    if (!order?.claimHash) return false;
    const got = createHash("sha256").update(rawClaim).digest();
    const want = Buffer.from(order.claimHash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * Re-issue a download grant for an already-fulfilled order.
   *
   * AUDIT #9: the token was emitted exactly once, at the instant payment
   * was first observed, and only the hash was kept — so a tab closed at
   * the wrong moment permanently forfeited a paid file. The caller must
   * have proven the claim secret.
   */
  reissueDownloadToken(orderId: string): { downloadToken: string; expiresAtTs: number } {
    const order = this.orders.get(orderId);
    if (!order) throw new OrderError(`unknown order ${orderId}`);
    if (order.status !== "fulfilled") {
      throw new OrderError(`order ${orderId} is ${order.status}, not fulfilled`);
    }
    const now = this.clock.now();
    const raw = randomBytes(24).toString("base64url");
    order.downloadToken = createHash("sha256").update(raw).digest("hex");
    order.downloadExpiresAtTs = now + this.config.downloadTtlSeconds;
    this.commit({
      kind: "OrderFulfilled",
      ts: now,
      orderId,
      downloadToken: order.downloadToken,
      expiresAtTs: order.downloadExpiresAtTs,
    });
    return { downloadToken: raw, expiresAtTs: order.downloadExpiresAtTs };
  }

  /**
   * Record a VERIFIED payment (caller must have checked mint, amount,
   * recipient and finalized commitment — see verifyPayment). Idempotent on
   * the signature; returns the order when it transitions to paid.
   */
  observePayment(orderId: string, payment: PaymentProof): Order | null {
    const now = this.clock.now();
    const order = this.orders.get(orderId);
    if (!order) throw new OrderError(`unknown order ${orderId}`);
    if (this.usedSignatures.has(payment.txSignature)) return null; // replay
    if (order.status !== "awaiting-payment") return null; // already settled

    if (payment.amountUsdc !== order.amountUsdc) {
      // Verified-but-wrong amounts are never silently accepted.
      this.usedSignatures.add(payment.txSignature);
      order.status = "refund-due";
      // Record the proof: the operator needs the sender and amount to
      // issue the refund, and needsAttention() filters on it. Without
      // this the money is taken and the refund never surfaces anywhere.
      order.payment = payment;
      this.commit({
        kind: "RefundDue",
        ts: now,
        orderId,
        reason: `amount ${payment.amountUsdc} != expected ${order.amountUsdc}`,
        txSignature: payment.txSignature,
        payment,
      });
      return null;
    }
    if (now > order.expiresAtTs) {
      this.usedSignatures.add(payment.txSignature);
      order.status = "refund-due";
      order.payment = payment; // see above — refunds need the proof

      this.commit({
        kind: "RefundDue",
        ts: now,
        orderId,
        reason: "order expired before payment",
        txSignature: payment.txSignature,
        payment,
      });
      return null;
    }

    this.usedSignatures.add(payment.txSignature);
    order.status = "paid";
    order.payment = payment;
    this.commit({ kind: "PaymentObserved", ts: now, orderId, payment });
    return order;
  }

  /**
   * Grant access. Pre-order products are NOT auto-fulfilled — they stay
   * `paid` until the dataset is delivered manually.
   */
  fulfil(orderId: string): { downloadToken: string; expiresAtTs: number } {
    const now = this.clock.now();
    const order = this.orders.get(orderId);
    if (!order) throw new OrderError(`unknown order ${orderId}`);
    if (order.status !== "paid") {
      throw new OrderError(`order ${orderId} is ${order.status}, not paid`);
    }
    if (PRODUCTS[order.productId].preOrder) {
      throw new OrderError(`${order.productId} is a pre-order — delivered manually`);
    }
    // Single-use, short-lived grant: the token is stored hashed, so a
    // leaked ledger cannot be used to download.
    const raw = randomBytes(24).toString("base64url");
    order.downloadToken = createHash("sha256").update(raw).digest("hex");
    order.downloadExpiresAtTs = now + this.config.downloadTtlSeconds;
    order.status = "fulfilled";
    this.commit({
      kind: "OrderFulfilled",
      ts: now,
      orderId,
      downloadToken: order.downloadToken,
      expiresAtTs: order.downloadExpiresAtTs,
    });
    return { downloadToken: raw, expiresAtTs: order.downloadExpiresAtTs };
  }

  /** Validate a download token presented by a client (constant-time-ish). */
  checkDownloadToken(orderId: string, rawToken: string): boolean {
    const order = this.orders.get(orderId);
    if (!order?.downloadToken || !order.downloadExpiresAtTs) return false;
    if (this.clock.now() > order.downloadExpiresAtTs) return false;
    const hashed = createHash("sha256").update(rawToken).digest("hex");
    return hashed === order.downloadToken;
  }

  expireStale(): number {
    const now = this.clock.now();
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.status === "awaiting-payment" && now > o.expiresAtTs) {
        o.status = "expired";
        this.commit({ kind: "OrderExpired", ts: now, orderId: o.orderId });
        n++;
      }
    }
    return n;
  }

  /** Orders needing operator action: refunds due, or paid pre-orders. */
  needsAttention(): { refunds: Order[]; preOrdersToDeliver: Order[] } {
    const all = [...this.orders.values()];
    return {
      refunds: all.filter(
        (o) => o.status === "refund-due" && (o.payment?.amountUsdc ?? 0) >= this.config.minRefundUsdc,
      ),
      preOrdersToDeliver: all.filter(
        (o) => o.status === "paid" && PRODUCTS[o.productId].preOrder,
      ),
    };
  }

  /** Rebuild from a persisted event log. */
  static fromEvents(
    config: CommerceConfig,
    clock: Clock,
    events: readonly OrderEvent[],
  ): OrderLedger {
    const ledger = new OrderLedger(config, clock);
    for (const e of events) {
      switch (e.kind) {
        case "OrderCreated":
          ledger.orders.set(e.order.orderId, structuredClone(e.order));
          break;
        case "PaymentObserved": {
          const o = ledger.orders.get(e.orderId);
          if (!o) throw new OrderError(`replay: unknown order ${e.orderId}`);
          o.status = "paid";
          o.payment = structuredClone(e.payment);
          ledger.usedSignatures.add(e.payment.txSignature);
          break;
        }
        case "OrderFulfilled": {
          const o = ledger.orders.get(e.orderId);
          if (!o) throw new OrderError(`replay: unknown order ${e.orderId}`);
          o.status = "fulfilled";
          o.downloadToken = e.downloadToken;
          o.downloadExpiresAtTs = e.expiresAtTs;
          break;
        }
        case "OrderExpired": {
          const o = ledger.orders.get(e.orderId);
          if (o) o.status = "expired";
          break;
        }
        case "RefundDue": {
          const o = ledger.orders.get(e.orderId);
          if (o) {
            o.status = "refund-due";
            if (e.payment) o.payment = structuredClone(e.payment);
          }
          // A9: a rejected signature must stay rejected across restarts,
          // or it could later be credited to a different order.
          if (e.txSignature) ledger.usedSignatures.add(e.txSignature);
          break;
        }
      }
      ledger.events.push(structuredClone(e));
    }
    return ledger;
  }

  statusOf(orderId: string): OrderStatus | null {
    return this.orders.get(orderId)?.status ?? null;
  }
}
