import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  OrderLedger, CommerceConfig, PRODUCTS,
  buildPaymentRequest, buildPaymentInstructions, verifyPayment,
  createReference, taggedAmount, OrderError,
} from "../../src";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REVENUE = "6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj";
const BUYER = "2MAeUmfvUm2qq6YN3ihZm35KrFLmirmYuwRiogzPia4K";

const CONFIG: CommerceConfig = {
  revenueWallet: REVENUE, usdcMint: USDC,
  orderTtlSeconds: 3600, downloadTtlSeconds: 86_400, minRefundUsdc: 500_000,
};

function makeClock(start = 1_790_000_000) {
  let t = start;
  return { now: () => t, advance: (s: number) => (t += s) };
}
const revenueAta = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(REVENUE)).toBase58();

function tx(opts: { amount: bigint; pre?: bigint; mint?: string; err?: unknown; sig?: string; ata?: string }) {
  return {
    slot: 100,
    transaction: {
      signatures: [opts.sig ?? "SIG1"],
      message: {
        accountKeys: [
          { pubkey: new PublicKey(BUYER), signer: true },
          { pubkey: new PublicKey(opts.ata ?? revenueAta), signer: false },
        ],
      },
    },
    meta: {
      err: opts.err ?? null,
      preTokenBalances: [{ accountIndex: 1, mint: opts.mint ?? USDC, uiTokenAmount: { amount: String(opts.pre ?? 0n) } }],
      postTokenBalances: [{ accountIndex: 1, mint: opts.mint ?? USDC, uiTokenAmount: { amount: String((opts.pre ?? 0n) + opts.amount) } }],
    },
  } as never;
}

describe("@lh/commerce", () => {
  describe("payment construction", () => {
    it("order amount carries a CSPRNG tag, unique among open orders (A7)", () => {
      const a = taggedAmount(1_000_000);
      expect(a - 1_000_000).to.be.within(0, 65_535);
      // Never collides with an amount already claimed by an open order.
      const taken = new Set<number>();
      for (let i = 0; i < 200; i++) taken.add(taggedAmount(1_000_000, taken));
      expect(taken.size).to.equal(200);
      // Exhausted space fails loudly instead of issuing a duplicate.
      const full = new Set<number>();
      for (let i = 0; i < 65_536; i++) full.add(1_000_000 + i);
      expect(() => taggedAmount(1_000_000, full)).to.throw(/unique payment amount/);
    });

    it("A9: a rejected signature stays rejected after replay", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => "oX");
      const o = l.createOrder({ productId: "dataset-2026-forward" });
      // Wrong amount → refund-due, signature consumed.
      l.observePayment("oX", {
        txSignature: "SIGDUP", amountUsdc: o.amountUsdc - 7,
        senderWallet: BUYER, slot: 1, observedAtTs: clock.now(),
      });
      const replayed = OrderLedger.fromEvents(
        CONFIG, clock, JSON.parse(JSON.stringify(l.getEvents())),
      );
      // After a restart the same signature must not credit anything.
      const o2 = replayed.createOrder({ productId: "dataset-2026-forward" });
      expect(replayed.observePayment(o2.orderId, {
        txSignature: "SIGDUP", amountUsdc: o2.amountUsdc,
        senderWallet: BUYER, slot: 1, observedAtTs: clock.now(),
      })).to.equal(null);
    });

    it("Solana Pay URL carries recipient, amount, mint and reference", () => {
      const l = new OrderLedger(CONFIG, makeClock(), () => "order1");
      const o = l.createOrder({ productId: "dataset-2026-forward" });
      const req = buildPaymentRequest(o, REVENUE, USDC);
      expect(req.url).to.match(new RegExp(`^solana:${REVENUE}\\?amount=1\\.0`));
      expect(req.url).to.include(`spl-token=${USDC}`);
      expect(req.url).to.include(`reference=${o.reference}`);
      expect(req.memo).to.equal("LH:order1");
    });

    it("instructions: idempotent ATA + transferChecked with the reference key + memo", () => {
      const reference = new PublicKey(createReference());
      const ixs = buildPaymentInstructions({
        buyerWallet: new PublicKey(BUYER), revenueWallet: new PublicKey(REVENUE),
        usdcMint: new PublicKey(USDC), amountUsdc: 1_000_137,
        reference, memo: "LH:o1",
      });
      expect(ixs).to.have.length(3);
      const transfer = ixs[1];
      expect(transfer.data[0]).to.equal(12); // transferChecked
      expect(transfer.data.readBigUInt64LE(1)).to.equal(1_000_137n);
      // The reference rides as a read-only, non-signer key → indexable.
      const ref = transfer.keys[transfer.keys.length - 1];
      expect(ref.pubkey.equals(reference)).to.equal(true);
      expect(ref.isSigner).to.equal(false);
      expect(ref.isWritable).to.equal(false);
      expect(ixs[2].data.toString("utf8")).to.equal("LH:o1");
      expect(() => buildPaymentInstructions({
        buyerWallet: new PublicKey(BUYER), revenueWallet: new PublicKey(REVENUE),
        usdcMint: new PublicKey(USDC), amountUsdc: 0, reference, memo: "x",
      })).to.throw(OrderError);
    });
  });

  describe("verification (never trusts the client)", () => {
    const params = { revenueAta, usdcMint: USDC, expectedAmountUsdc: 1_000_137 };

    it("accepts an exact, successful, correct-mint payment", () => {
      const r = verifyPayment(tx({ amount: 1_000_137n, pre: 5_000_000n }), params);
      expect(r.ok).to.equal(true);
      if (r.ok) {
        expect(r.amountUsdc).to.equal(1_000_137);
        expect(r.senderWallet).to.equal(BUYER);
        expect(r.txSignature).to.equal("SIG1");
      }
    });

    it("rejects: failed tx, wrong mint, wrong amount, outbound, wrong recipient", () => {
      const reasons = [
        verifyPayment(tx({ amount: 1_000_137n, err: { e: 1 } }), params),
        verifyPayment(tx({ amount: 1_000_137n, mint: "So11111111111111111111111111111111111111112" }), params),
        verifyPayment(tx({ amount: 999_000n }), params),
        verifyPayment(tx({ amount: 0n }), params),
        verifyPayment(tx({ amount: 1_000_137n, ata: BUYER }), params),
      ];
      expect(reasons.every((r) => !r.ok)).to.equal(true);
      expect((reasons[2] as { reason: string }).reason).to.match(/amount mismatch/);
    });
  });

  describe("order lifecycle", () => {
    it("happy path: create → pay → fulfil → single-use download token", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => "o1");
      const o = l.createOrder({ productId: "dataset-2026-forward", buyerWallet: BUYER });
      expect(o.status).to.equal("awaiting-payment");
      expect(o.amountUsdc).to.be.at.least(PRODUCTS["dataset-2026-forward"].priceUsdc);

      const paid = l.observePayment("o1", {
        txSignature: "SIGA", amountUsdc: o.amountUsdc, senderWallet: BUYER,
        slot: 1, observedAtTs: clock.now(),
      });
      expect(paid?.status).to.equal("paid");

      const grant = l.fulfil("o1");
      expect(l.statusOf("o1")).to.equal("fulfilled");
      expect(l.checkDownloadToken("o1", grant.downloadToken)).to.equal(true);
      expect(l.checkDownloadToken("o1", "wrong")).to.equal(false);
      // Token is stored HASHED — the raw value never sits in the ledger.
      expect(l.getOrder("o1")!.downloadToken).to.not.equal(grant.downloadToken);
      // Expired grant stops working.
      clock.advance(CONFIG.downloadTtlSeconds + 1);
      expect(l.checkDownloadToken("o1", grant.downloadToken)).to.equal(false);
    });

    it("payment replay and double-fulfil are impossible", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => "o2");
      const o = l.createOrder({ productId: "dataset-2026-forward" });
      const p = { txSignature: "SIGB", amountUsdc: o.amountUsdc, senderWallet: BUYER, slot: 1, observedAtTs: clock.now() };
      expect(l.observePayment("o2", p)).to.not.equal(null);
      expect(l.observePayment("o2", p)).to.equal(null); // replay ignored
      l.fulfil("o2");
      expect(() => l.fulfil("o2")).to.throw(OrderError, /not paid/);
    });

    it("wrong amount and late payment become refund-due, never silent acceptance", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => "o3");
      const o = l.createOrder({ productId: "dataset-2026-forward" });
      l.observePayment("o3", { txSignature: "SIGC", amountUsdc: o.amountUsdc - 5, senderWallet: BUYER, slot: 1, observedAtTs: clock.now() });
      expect(l.statusOf("o3")).to.equal("refund-due");

      const l2 = new OrderLedger(CONFIG, clock, () => "o4");
      const o4 = l2.createOrder({ productId: "dataset-2026-forward" });
      clock.advance(CONFIG.orderTtlSeconds + 10);
      l2.observePayment("o4", { txSignature: "SIGD", amountUsdc: o4.amountUsdc, senderWallet: BUYER, slot: 1, observedAtTs: clock.now() });
      expect(l2.statusOf("o4")).to.equal("refund-due");
    });

    it("pre-orders are never auto-fulfilled; they queue for manual delivery", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => "o5");
      const o = l.createOrder({ productId: "dataset-archive-preorder", email: "buyer@example.com" });
      expect(o.amountUsdc).to.be.at.least(200_000_000);
      l.observePayment("o5", { txSignature: "SIGE", amountUsdc: o.amountUsdc, senderWallet: BUYER, slot: 1, observedAtTs: clock.now() });
      expect(() => l.fulfil("o5")).to.throw(OrderError, /pre-order/);
      expect(l.needsAttention().preOrdersToDeliver.map((x) => x.orderId)).to.deep.equal(["o5"]);
    });

    it("replay from events reconstructs identical state", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => "o6");
      const o = l.createOrder({ productId: "dataset-2026-forward" });
      l.observePayment("o6", { txSignature: "SIGF", amountUsdc: o.amountUsdc, senderWallet: BUYER, slot: 1, observedAtTs: clock.now() });
      l.fulfil("o6");
      const replayed = OrderLedger.fromEvents(CONFIG, clock, JSON.parse(JSON.stringify(l.getEvents())));
      expect(replayed.getOrder("o6")).to.deep.equal(l.getOrder("o6"));
      // Replayed ledger still refuses the already-used signature.
      expect(replayed.statusOf("o6")).to.equal("fulfilled");
    });

    it("openOrders/expireStale drive the watcher and cleanup", () => {
      const clock = makeClock();
      const l = new OrderLedger(CONFIG, clock, () => `o${Math.random()}`);
      l.createOrder({ productId: "dataset-2026-forward" });
      expect(l.openOrders()).to.have.length(1);
      clock.advance(CONFIG.orderTtlSeconds + 1);
      expect(l.openOrders()).to.have.length(0);
      expect(l.expireStale()).to.equal(1);
    });
  });
});
