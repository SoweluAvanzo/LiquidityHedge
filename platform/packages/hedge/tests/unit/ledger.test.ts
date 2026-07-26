import { expect } from "chai";
import {
  CertificateLedger,
  IdSource,
  LedgerConfig,
  HedgedPositionInput,
  MarketInputs,
  buildTermSheet,
  termSheetHash,
  merkleRoot,
  eventLeafHash,
  canonicalJson,
  sha256Hex,
  LedgerError,
} from "../../src";

const CONFIG: LedgerConfig = {
  uMaxBps: 3000,
  protocolFeeBps: 150,
  premiumFloorUsdc: 1_500_000,
  markupFloor: 1.05,
  feeSplitRate: 0.1,
  expectedDailyFee: 0.005,
  tenorSeconds: 604_800,
  quoteTtlSeconds: 120,
  regimeMaxAgeSeconds: 900,
  perBuyerCapDownLimitUsdc: 0,
  maxOpenQuotesPerOwner: 5,
  maxLifetimeQuotes: 100_000,
  masterTermsVersion: "0.1-draft",
  masterTermsHash: sha256Hex("master-terms-0.1-draft"),
  treasuryAddress: "TREASURYaddr11111111111111111111111111111111",
};

function makeClock(start = 1_780_000_000) {
  let t = start;
  return { now: () => t, advance: (s: number) => (t += s) };
}

function makeIds(): IdSource {
  let q = 0;
  let r = 0;
  return { quoteId: () => `Q${++q}`, referenceKey: () => `REF${++r}` };
}

function makePosition(
  mint = "posMint1",
  price = 150,
  ownerWallet = "buyerWallet111",
): HedgedPositionInput {
  return {
    positionMint: mint,
    ownerWallet,
    whirlpool: "poolAddr111",
    liquidity: 1_000_000_000_000n,
    tickLower: -20000,
    tickUpper: -18000,
    decimalsA: 9,
    decimalsB: 6,
    currentPriceUsd: price,
  };
}

function market(clock: { now(): number }): MarketInputs {
  return { sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now() };
}

const RESERVES = 100_000_000_000; // $100k

function setup() {
  const clock = makeClock();
  const ledger = new CertificateLedger(CONFIG, clock, makeIds(), RESERVES);
  return { clock, ledger };
}

function buyFlow(ledger: CertificateLedger, clock: ReturnType<typeof makeClock>, mint = "posMint1") {
  const quote = ledger.issueQuote(makePosition(mint), market(clock));
  const { activated } = ledger.observePayment({
    txSignature: `tx-${mint}`,
    referenceKey: quote.referenceKey,
    senderWallet: "buyerWallet111",
    amountUsdc: quote.totalPayableUsdc,
  });
  return { quote, cert: activated! };
}

describe("@lh/hedge CertificateLedger", () => {
  it("quote carries the canonical breakdown and a stable term-sheet hash", () => {
    const { clock, ledger } = setup();
    const quote = ledger.issueQuote(makePosition(), market(clock));

    expect(quote.premiumUsdc).to.be.at.least(CONFIG.premiumFloorUsdc);
    // Canonical formula contract (C2-style, decimals-safe inputs):
    const b = quote.breakdown;
    const raw = Math.floor(b.fairValueUsdc * b.effectiveMarkup - b.feeDiscountUsdc);
    expect(quote.premiumUsdc).to.equal(Math.max(CONFIG.premiumFloorUsdc, raw));
    // Convexity wedge: collateral (capUp) strictly below capDown.
    expect(quote.capUpUsdc).to.be.greaterThan(0);
    expect(quote.capUpUsdc).to.be.lessThan(quote.capDownUsdc);
    expect(quote.totalPayableUsdc).to.equal(quote.premiumUsdc + quote.capUpUsdc);
    // Term sheet hash is deterministic and matches a rebuild.
    expect(quote.termSheetHash).to.equal(termSheetHash(buildTermSheet(quote, CONFIG)));
    expect(quote.termSheetHash).to.match(/^[0-9a-f]{64}$/);
  });

  it("exact payment activates exactly once; duplicates and wrong amounts never do", () => {
    const { clock, ledger } = setup();
    const quote = ledger.issueQuote(makePosition(), market(clock));

    // Wrong amount (premium only, no collateral) → no activation.
    const wrong = ledger.observePayment({
      txSignature: "tx-wrong",
      referenceKey: quote.referenceKey,
      senderWallet: "buyerWallet111",
      amountUsdc: quote.premiumUsdc,
    });
    expect(wrong.activated).to.equal(undefined);

    // Exact payment → activation.
    const ok = ledger.observePayment({
      txSignature: "tx-ok",
      referenceKey: quote.referenceKey,
      senderWallet: "buyerWallet111",
      amountUsdc: quote.totalPayableUsdc,
    });
    expect(ok.activated).to.not.equal(undefined);

    // Duplicate delivery of the same tx → idempotent no-op.
    const dup = ledger.observePayment({
      txSignature: "tx-ok",
      referenceKey: quote.referenceKey,
      senderWallet: "buyerWallet111",
      amountUsdc: quote.totalPayableUsdc,
    });
    expect(dup.accepted).to.equal(false);

    // A second exact payment can never create a second certificate.
    const second = ledger.observePayment({
      txSignature: "tx-second",
      referenceKey: quote.referenceKey,
      senderWallet: "buyerWallet111",
      amountUsdc: quote.totalPayableUsdc,
    });
    expect(second.activated).to.equal(undefined);
    expect(ledger.getState().certs.size).to.equal(1);

    // The wrong-amount and second payments are refundable; the matched one is not.
    expect(ledger.refundPayment("tx-wrong").amountUsdc).to.equal(quote.premiumUsdc);
    expect(ledger.refundPayment("tx-second").amountUsdc).to.equal(quote.totalPayableUsdc);
    expect(() => ledger.refundPayment("tx-ok")).to.throw(LedgerError, /already matched/);
    // Refunding twice is impossible.
    expect(() => ledger.refundPayment("tx-wrong")).to.throw(LedgerError, /already matched/);
  });

  it("A1: a payment from a NON-OWNER never activates (reference-leak hijack)", () => {
    const { clock, ledger } = setup();
    const quote = ledger.issueQuote(makePosition(), market(clock));
    // The reference is visible to anyone who can read a quote. An attacker
    // paying the exact amount must NOT obtain the certificate.
    const attacker = ledger.observePayment({
      txSignature: "tx-attacker",
      referenceKey: quote.referenceKey,
      senderWallet: "attackerWallet",
      amountUsdc: quote.totalPayableUsdc,
    });
    expect(attacker.activated).to.equal(undefined);
    expect(ledger.getState().certs.size).to.equal(0);

    // The rightful owner can still activate afterwards.
    const owner = ledger.observePayment({
      txSignature: "tx-owner",
      referenceKey: quote.referenceKey,
      senderWallet: "buyerWallet111",
      amountUsdc: quote.totalPayableUsdc,
    });
    expect(owner.activated).to.not.equal(undefined);
    expect(owner.activated!.buyerWallet).to.equal("buyerWallet111");
    // The attacker's funds are unmatched → refundable, never kept.
    expect(ledger.refundPayment("tx-attacker").to).to.equal("attackerWallet");
  });

  it("settlement pays max(0, payoff − feeSplit + collateral) on all three payoff branches", () => {
    const reading = (priceUsd: number) => ({
      priceUsd,
      slot: 1,
      crossCheckPriceUsd: priceUsd,
      divergenceBps: 0,
    });
    const fees = 2_000_000; // $2 accrued

    // Branch 1: price crashes below corridor → payoff = +capDown.
    {
      const { clock, ledger } = setup();
      const { quote, cert } = buyFlow(ledger, clock);
      clock.advance(CONFIG.tenorSeconds + 1);
      const { settlementAmountUsdc } = ledger.settle(quote.quoteId, reading(100), fees);
      const s = ledger.getState().certs.get(quote.quoteId)!.settlement!;
      // Payoff reaches capDown up to µUSDC rounding (capDown is ceil'd at
      // quote time for collateral safety; the payoff is truncated) and the
      // §7.2 identity holds exactly on the recorded payoff.
      expect(s.payoffUsdc).to.be.closeTo(cert.capDownUsdc, 3);
      expect(s.payoffUsdc).to.be.at.most(cert.capDownUsdc);
      expect(settlementAmountUsdc).to.equal(
        s.payoffUsdc - Math.floor(0.1 * fees) + cert.capUpUsdc,
      );
      expect(ledger.getState().certs.get(quote.quoteId)!.status).to.equal("settled");
    }

    // Branch 2: price unchanged → payoff 0, buyer gets collateral − feeSplit.
    {
      const { clock, ledger } = setup();
      const { quote, cert } = buyFlow(ledger, clock);
      clock.advance(CONFIG.tenorSeconds + 1);
      const { settlementAmountUsdc } = ledger.settle(quote.quoteId, reading(150), fees);
      expect(settlementAmountUsdc).to.equal(cert.capUpUsdc - Math.floor(0.1 * fees));
      expect(ledger.getState().certs.get(quote.quoteId)!.status).to.equal("expired");
    }

    // Branch 3: price rips above corridor → payoff = −capUp, buyer gets ~0.
    {
      const { clock, ledger } = setup();
      const { quote } = buyFlow(ledger, clock);
      clock.advance(CONFIG.tenorSeconds + 1);
      const { settlementAmountUsdc } = ledger.settle(quote.quoteId, reading(200), fees);
      expect(settlementAmountUsdc).to.equal(0); // −capUp − feeSplit + capUp < 0 → floored
    }
  });

  it("settlement works WHILE PAUSED and refuses only before expiry (I5)", () => {
    const { clock, ledger } = setup();
    const { quote } = buyFlow(ledger, clock);
    ledger.setPaused(true);
    expect(() =>
      ledger.settle(quote.quoteId, { priceUsd: 140, slot: 1, crossCheckPriceUsd: 140, divergenceBps: 0 }, 0),
    ).to.throw(LedgerError, /not expired/);
    clock.advance(CONFIG.tenorSeconds + 1);
    expect(ledger.dueForSettlement().map((c) => c.quoteId)).to.deep.equal([quote.quoteId]);
    const r = ledger.settle(
      quote.quoteId,
      { priceUsd: 140, slot: 1, crossCheckPriceUsd: 140, divergenceBps: 0 },
      0,
    );
    expect(r.settlementAmountUsdc).to.be.greaterThan(0);
    // While paused: no new quotes, no activation.
    expect(() => ledger.issueQuote(makePosition("m2"), market(clock))).to.throw(/paused/);
  });

  it("headroom guard (E12): quotes refused when exposure would exceed uMax of NET reserves", () => {
    const clock = makeClock();
    // Tiny treasury: $1,000 → 30% headroom = $300, but capDown ≈ $2.8k.
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 1_000_000_000);
    expect(() => ledger.issueQuote(makePosition(), market(clock))).to.throw(
      LedgerError,
      /utilization headroom/,
    );
  });

  it("stale regime and double-protection are refused", () => {
    const { clock, ledger } = setup();
    expect(() =>
      ledger.issueQuote(makePosition(), {
        sigmaAnnual: 0.6,
        ivRvRatio: 1.08,
        regimeUpdatedAtTs: clock.now() - 901,
      }),
    ).to.throw(LedgerError, /stale/);
    buyFlow(ledger, clock);
    expect(() => ledger.issueQuote(makePosition(), market(clock))).to.throw(
      LedgerError,
      /already protected/,
    );
  });

  it("audit event log is complete and Merkle-anchorable", () => {
    const { clock, ledger } = setup();
    const { quote } = buyFlow(ledger, clock);
    clock.advance(CONFIG.tenorSeconds + 1);
    ledger.settle(
      quote.quoteId,
      { priceUsd: 145, slot: 9, crossCheckPriceUsd: 145.01, divergenceBps: 1 },
      1_000_000,
    );
    const kinds = ledger.getEvents().map((e) => e.kind);
    expect(kinds).to.deep.equal([
      "LedgerOpened",
      "QuoteIssued",
      "PaymentObserved",
      "CertificateActivated",
      "CertificateSettled",
    ]);
    const leaves = ledger.getEvents().map((e) => eventLeafHash(canonicalJson(e)));
    const root = merkleRoot(leaves);
    expect(root).to.match(/^[0-9a-f]{64}$/);
    // Deterministic: same events → same root; any tamper changes it.
    expect(merkleRoot(leaves)).to.equal(root);
    const tampered = [...leaves];
    tampered[1] = eventLeafHash("forged");
    expect(merkleRoot(tampered)).to.not.equal(root);
  });
});

describe("@lh/hedge per-buyer exposure cap (FR-H9)", () => {
  it("second certificate for the same wallet is refused when the cap binds", () => {
    const clock = makeClock();
    const capped = { ...CONFIG, perBuyerCapDownLimitUsdc: 3_000_000_000 }; // $3k
    const ledger = new CertificateLedger(capped, clock, makeIds(), RESERVES);
    const q1 = ledger.issueQuote(makePosition("m1", 150, "sameBuyer"), market(clock));
    const r1 = ledger.observePayment({
      txSignature: "t1", referenceKey: q1.referenceKey,
      senderWallet: "sameBuyer", amountUsdc: q1.totalPayableUsdc,
    });
    expect(r1.activated).to.not.equal(undefined); // capDown ≈ $2.8k ≤ $3k
    const q2 = ledger.issueQuote(makePosition("m2", 150, "sameBuyer"), market(clock));
    const r2 = ledger.observePayment({
      txSignature: "t2", referenceKey: q2.referenceKey,
      senderWallet: "sameBuyer", amountUsdc: q2.totalPayableUsdc,
    });
    expect(r2.activated).to.equal(undefined); // cap binds → unmatched
    // Model-faithful refund semantics: an exact-amount payment for a still-
    // open quote is refundable only once the quote TTL lapses (≤120 s).
    expect(() => ledger.refundPayment("t2")).to.throw(LedgerError, /still matchable/);
    clock.advance(CONFIG.quoteTtlSeconds + 1);
    expect(ledger.refundPayment("t2").amountUsdc).to.equal(q2.totalPayableUsdc);
    // A different wallet is unaffected.
    const q3 = ledger.issueQuote(makePosition("m3", 150, "otherBuyer"), market(clock));
    const r3 = ledger.observePayment({
      txSignature: "t3", referenceKey: q3.referenceKey,
      senderWallet: "otherBuyer", amountUsdc: q3.totalPayableUsdc,
    });
    expect(r3.activated).to.not.equal(undefined);
  });
});
