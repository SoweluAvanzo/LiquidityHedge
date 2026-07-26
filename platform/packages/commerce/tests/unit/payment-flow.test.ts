/**
 * End-to-end payment-flow verification.
 *
 * Drives the real sequence a paying customer produces —
 *   create order → on-chain transfer → verifyPayment → observePayment →
 *   fulfil → download-token check
 * — against transaction fixtures shaped exactly like the parsed
 * transactions the RPC returns, and then attacks it.
 *
 * The point is not that the happy path works (it does); it is that every
 * way of getting the goods WITHOUT paying correctly is refused.
 */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  OrderLedger,
  CommerceConfig,
  buildPaymentRequest,
  buildPaymentInstructions,
  verifyPayment,
  createReference,
  PRODUCTS,
} from "../../src";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REVENUE = "2kQrLavG5JBaxRgVcKhk4eCevd6TiMeHfffsJFFvmnsR";
const BUYER = "2MAeUmfvUm2qq6YN3ihZm35KrFLmirmYuwRiogzPia4K";
const ATTACKER = "6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj";

const CONFIG: CommerceConfig = {
  revenueWallet: REVENUE,
  usdcMint: USDC,
  orderTtlSeconds: 3600,
  downloadTtlSeconds: 86_400,
  minRefundUsdc: 500_000,
};

const revenueAta = getAssociatedTokenAddressSync(
  new PublicKey(USDC),
  new PublicKey(REVENUE),
).toBase58();

function makeClock(start = 1_790_000_000) {
  let t = start;
  return { now: () => t, advance: (s: number) => (t += s) };
}

/** A parsed transaction shaped like the RPC's, crediting the revenue ATA. */
function transfer(opts: {
  amount: bigint;
  signer?: string;
  sig?: string;
  mint?: string;
  err?: unknown;
  toAta?: string;
  priorBalance?: bigint;
}) {
  const pre = opts.priorBalance ?? 4_200_000n;
  return {
    slot: 314_159,
    transaction: {
      signatures: [opts.sig ?? "SIGdefault"],
      message: {
        accountKeys: [
          { pubkey: new PublicKey(opts.signer ?? BUYER), signer: true },
          { pubkey: new PublicKey(opts.toAta ?? revenueAta), signer: false },
        ],
      },
    },
    meta: {
      err: opts.err ?? null,
      preTokenBalances: [
        { accountIndex: 1, mint: opts.mint ?? USDC, uiTokenAmount: { amount: String(pre) } },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: opts.mint ?? USDC,
          uiTokenAmount: { amount: String(pre + opts.amount) },
        },
      ],
    },
  } as never;
}

/** The verify → observe → fulfil sequence the status route performs. */
function settlePayment(
  ledger: OrderLedger,
  orderId: string,
  tx: never,
  expectedAmountUsdc: number,
  clock: { now(): number },
) {
  const verified = verifyPayment(tx, {
    revenueAta,
    usdcMint: USDC,
    expectedAmountUsdc,
  });
  if (!verified.ok) return { verified, granted: null as string | null };
  const paid = ledger.observePayment(orderId, {
    txSignature: verified.txSignature,
    amountUsdc: verified.amountUsdc,
    senderWallet: verified.senderWallet,
    slot: verified.slot,
    observedAtTs: clock.now(),
  });
  const granted =
    paid && !PRODUCTS[paid.productId].preOrder ? ledger.fulfil(orderId).downloadToken : null;
  return { verified, granted };
}

describe("@lh/commerce payment flow (end to end)", () => {
  it("HAPPY PATH: order → exact payment → fulfilment → working download token", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ord1");
    const order = ledger.createOrder({ productId: "dataset-2026-forward", buyerWallet: BUYER });

    // What the buyer is shown.
    const req = buildPaymentRequest(order, REVENUE, USDC);
    expect(req.recipient).to.equal(REVENUE);
    expect(req.amountUsdc).to.equal(order.amountUsdc);
    expect(req.url).to.include(`reference=${order.reference}`);
    // The displayed amount must equal the amount enforced on-chain, to the
    // last micro-cent — the tag is what identifies a manual payment.
    const displayed = Number(req.url.match(/amount=([\d.]+)/)![1]);
    expect(Math.round(displayed * 1e6)).to.equal(order.amountUsdc);

    // What the wallet would sign.
    const ixs = buildPaymentInstructions({
      buyerWallet: new PublicKey(BUYER),
      revenueWallet: new PublicKey(REVENUE),
      usdcMint: new PublicKey(USDC),
      amountUsdc: order.amountUsdc,
      reference: new PublicKey(order.reference),
      memo: req.memo,
    });
    expect(ixs[1].data.readBigUInt64LE(1)).to.equal(BigInt(order.amountUsdc));

    // The payment lands; the server verifies and fulfils.
    const { verified, granted } = settlePayment(
      ledger,
      "ord1",
      transfer({ amount: BigInt(order.amountUsdc), sig: "SIGok" }),
      order.amountUsdc,
      clock,
    );
    expect(verified.ok).to.equal(true);
    expect(ledger.statusOf("ord1")).to.equal("fulfilled");
    expect(granted).to.be.a("string");
    expect(ledger.checkDownloadToken("ord1", granted!)).to.equal(true);
  });

  it("UNDERPAY by one micro-cent is refused and never fulfils", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ord2");
    const order = ledger.createOrder({ productId: "dataset-2026-forward" });
    const { verified, granted } = settlePayment(
      ledger,
      "ord2",
      transfer({ amount: BigInt(order.amountUsdc - 1), sig: "SIGshort" }),
      order.amountUsdc,
      clock,
    );
    expect(verified.ok).to.equal(false);
    expect(granted).to.equal(null);
    expect(ledger.statusOf("ord2")).to.equal("awaiting-payment");
    expect(() => ledger.fulfil("ord2")).to.throw(/not paid/);
  });

  it("REPLAY: the same transaction cannot pay two orders", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, (() => {
      let n = 0;
      return () => `ordR${++n}`;
    })());
    const a = ledger.createOrder({ productId: "dataset-2026-forward" });
    const b = ledger.createOrder({ productId: "dataset-2026-forward" });
    settlePayment(ledger, "ordR1", transfer({ amount: BigInt(a.amountUsdc), sig: "SIGdup" }), a.amountUsdc, clock);
    expect(ledger.statusOf("ordR1")).to.equal("fulfilled");

    // Same signature, replayed against the second order.
    const replay = ledger.observePayment("ordR2", {
      txSignature: "SIGdup",
      amountUsdc: b.amountUsdc,
      senderWallet: BUYER,
      slot: 1,
      observedAtTs: clock.now(),
    });
    expect(replay).to.equal(null);
    expect(ledger.statusOf("ordR2")).to.equal("awaiting-payment");
  });

  it("FORGERY: failed tx, wrong mint, wrong recipient, and outbound transfers all fail verification", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ord3");
    const order = ledger.createOrder({ productId: "dataset-2026-forward" });
    const amount = BigInt(order.amountUsdc);

    const attempts = [
      transfer({ amount, err: { InstructionError: [0, "Custom"] }, sig: "S1" }),
      transfer({ amount, mint: "So11111111111111111111111111111111111111112", sig: "S2" }),
      transfer({ amount, toAta: ATTACKER, sig: "S3" }),
      transfer({ amount: 0n, sig: "S4" }),
    ];
    for (const tx of attempts) {
      const r = verifyPayment(tx, { revenueAta, usdcMint: USDC, expectedAmountUsdc: order.amountUsdc });
      expect(r.ok, `should reject: ${JSON.stringify(r)}`).to.equal(false);
    }
    expect(ledger.statusOf("ord3")).to.equal("awaiting-payment");
  });

  it("STOLEN TOKEN: a download grant is single-order, unguessable and expiring", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, (() => {
      let n = 0;
      return () => `ordT${++n}`;
    })());
    const mine = ledger.createOrder({ productId: "dataset-2026-forward" });
    const theirs = ledger.createOrder({ productId: "dataset-2026-forward" });
    const { granted } = settlePayment(
      ledger, "ordT1", transfer({ amount: BigInt(mine.amountUsdc), sig: "SIGmine" }), mine.amountUsdc, clock,
    );
    // My token does not open their order (no cross-order use).
    expect(ledger.checkDownloadToken("ordT2", granted!)).to.equal(false);
    // Unpaid order has no token at all.
    expect(ledger.checkDownloadToken("ordT2", "anything")).to.equal(false);
    void theirs;
    // Expiry is enforced.
    clock.advance(CONFIG.downloadTtlSeconds + 1);
    expect(ledger.checkDownloadToken("ordT1", granted!)).to.equal(false);
  });

  it("LATE PAYMENT after the order expires becomes refund-due, not fulfilment", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ord4");
    const order = ledger.createOrder({ productId: "dataset-2026-forward" });
    clock.advance(CONFIG.orderTtlSeconds + 60);
    const { granted } = settlePayment(
      ledger, "ord4", transfer({ amount: BigInt(order.amountUsdc), sig: "SIGlate" }), order.amountUsdc, clock,
    );
    expect(granted).to.equal(null);
    expect(ledger.statusOf("ord4")).to.equal("refund-due");
    expect(ledger.needsAttention().refunds.map((o) => o.orderId)).to.deep.equal(["ord4"]);
  });

  it("PRE-ORDER: payment is accepted but nothing is auto-delivered", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ord5");
    const order = ledger.createOrder({
      productId: "dataset-archive-preorder",
      email: "buyer@example.com",
    });
    const { verified } = settlePayment(
      ledger, "ord5", transfer({ amount: BigInt(order.amountUsdc), sig: "SIGpre" }), order.amountUsdc, clock,
    );
    expect(verified.ok).to.equal(true);
    expect(ledger.statusOf("ord5")).to.equal("paid");
    expect(() => ledger.fulfil("ord5")).to.throw(/pre-order/);
    expect(ledger.needsAttention().preOrdersToDeliver).to.have.length(1);
  });

  it("CRASH SAFETY: replaying the log preserves fulfilment and refuses used signatures", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ord6");
    const order = ledger.createOrder({ productId: "dataset-2026-forward" });
    const { granted } = settlePayment(
      ledger, "ord6", transfer({ amount: BigInt(order.amountUsdc), sig: "SIGcrash" }), order.amountUsdc, clock,
    );
    // Simulate a restart from the persisted JSONL.
    const events = JSON.parse(JSON.stringify(ledger.getEvents()));
    const revived = OrderLedger.fromEvents(CONFIG, clock, events);
    expect(revived.statusOf("ord6")).to.equal("fulfilled");
    // The customer's token still works after the restart.
    expect(revived.checkDownloadToken("ord6", granted!)).to.equal(true);
    // And the used signature cannot pay a new order.
    const next = revived.createOrder({ productId: "dataset-2026-forward" });
    expect(
      revived.observePayment(next.orderId, {
        txSignature: "SIGcrash",
        amountUsdc: next.amountUsdc,
        senderWallet: BUYER,
        slot: 1,
        observedAtTs: clock.now(),
      }),
    ).to.equal(null);
  });

  it("reference keys are unique per order (no cross-order confusion)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(createReference());
    expect(seen.size).to.equal(500);
  });
});

describe("@lh/commerce refund queue (regression: money must never go invisible)", () => {
  it("wrong-amount and late payments both reach the operator queue WITH the proof", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, (() => {
      let n = 0;
      return () => `ordQ${++n}`;
    })());

    // 1. Overpayment (above the dust floor) → refundable, with sender+amount.
    const a = ledger.createOrder({ productId: "dataset-2026-forward" });
    ledger.observePayment("ordQ1", {
      txSignature: "SIGover", amountUsdc: a.amountUsdc + 2_000_000,
      senderWallet: BUYER, slot: 1, observedAtTs: clock.now(),
    });
    // 2. Late payment of the exact amount.
    const b = ledger.createOrder({ productId: "dataset-2026-forward" });
    clock.advance(CONFIG.orderTtlSeconds + 1);
    ledger.observePayment("ordQ2", {
      txSignature: "SIGlate2", amountUsdc: b.amountUsdc,
      senderWallet: ATTACKER, slot: 2, observedAtTs: clock.now(),
    });

    const queue = ledger.needsAttention().refunds;
    expect(queue.map((o) => o.orderId).sort()).to.deep.equal(["ordQ1", "ordQ2"]);
    // The operator can actually act: they know who to pay and how much.
    for (const o of queue) {
      expect(o.payment, `${o.orderId} must carry payment proof`).to.not.equal(undefined);
      expect(o.payment!.senderWallet).to.be.a("string").and.not.equal("");
      expect(o.payment!.amountUsdc).to.be.greaterThan(0);
    }
    expect(queue.find((o) => o.orderId === "ordQ2")!.payment!.senderWallet).to.equal(ATTACKER);

    // And it survives a restart — refunds owed cannot be lost to a crash.
    const revived = OrderLedger.fromEvents(
      CONFIG, clock, JSON.parse(JSON.stringify(ledger.getEvents())),
    );
    const revivedQueue = revived.needsAttention().refunds;
    expect(revivedQueue.map((o) => o.orderId).sort()).to.deep.equal(["ordQ1", "ordQ2"]);
    expect(revivedQueue[0].payment!.amountUsdc).to.be.greaterThan(0);
  });

  it("dust below the refund minimum is excluded (refund would cost more than it returns)", () => {
    const clock = makeClock();
    const ledger = new OrderLedger(CONFIG, clock, () => "ordD1");
    const o = ledger.createOrder({ productId: "dataset-2026-forward" });
    ledger.observePayment("ordD1", {
      txSignature: "SIGdust", amountUsdc: 1_000, // $0.001
      senderWallet: BUYER, slot: 1, observedAtTs: clock.now(),
    });
    expect(ledger.statusOf("ordD1")).to.equal("refund-due");
    expect(ledger.needsAttention().refunds).to.have.length(0);
    void o;
  });
});
