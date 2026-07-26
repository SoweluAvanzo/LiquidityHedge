import { expect } from "chai";
import {
  CertificateLedger,
  IdSource,
  LedgerConfig,
  HedgedPositionInput,
  sha256Hex,
} from "../../src";
import { LedgerEvent } from "../../src/ledger";

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

function makeIds(): IdSource {
  let q = 0,
    r = 0;
  return { quoteId: () => `Q${++q}`, referenceKey: () => `REF${++r}` };
}

const POS: HedgedPositionInput = {
  positionMint: "mintA",
  ownerWallet: "buyer1",
  whirlpool: "pool",
  liquidity: 1_000_000_000_000n,
  tickLower: -20000,
  tickUpper: -18000,
  decimalsA: 9,
  decimalsB: 6,
  currentPriceUsd: 150,
};

describe("@lh/hedge event-sourced replay (NFR-A1)", () => {
  it("JSONL round-trip: replayed ledger state ≡ live state; history is immutable", () => {
    let t = 1_780_000_000;
    const clock = { now: () => t };
    const live = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);

    // Lifecycle: quote → wrong payment → exact payment (activate) →
    // refund the wrong one → pause → expire → settle (while paused).
    const quote = live.issueQuote(POS, {
      sigmaAnnual: 0.6,
      ivRvRatio: 1.08,
      regimeUpdatedAtTs: t,
    });
    live.observePayment({
      txSignature: "txWrong",
      referenceKey: quote.referenceKey,
      senderWallet: "buyer1",
      amountUsdc: quote.premiumUsdc,
    });
    live.observePayment({
      txSignature: "txOk",
      referenceKey: quote.referenceKey,
      senderWallet: "buyer1",
      amountUsdc: quote.totalPayableUsdc,
    });
    live.refundPayment("txWrong");
    live.setPaused(true);
    t += CONFIG.tenorSeconds + 5;
    live.settle(
      quote.quoteId,
      { priceUsd: 141.5, slot: 42, crossCheckPriceUsd: 141.52, divergenceBps: 1 },
      1_234_567,
    );

    // History immutability: the QuoteIssued event still says "open" even
    // though the live quote is long consumed.
    const issued = live
      .getEvents()
      .find((e) => e.kind === "QuoteIssued") as Extract<LedgerEvent, { kind: "QuoteIssued" }>;
    expect(issued.quote.status).to.equal("open");
    expect(live.getState().quotes.get(quote.quoteId)!.status).to.equal("consumed");
    const observed = live
      .getEvents()
      .filter((e) => e.kind === "PaymentObserved") as Extract<
      LedgerEvent,
      { kind: "PaymentObserved" }
    >[];
    for (const ev of observed) expect(ev.payment.matched).to.equal(false);

    // JSONL round-trip (what the persistence layer stores).
    const jsonl = live.getEvents().map((e) => JSON.stringify(e)).join("\n");
    const parsed = jsonl.split("\n").map((l) => JSON.parse(l)) as LedgerEvent[];
    const replayed = CertificateLedger.fromEvents(CONFIG, clock, makeIds(), parsed);

    const a = live.getState();
    const b = replayed.getState();
    expect(b.treasuryUsdc).to.equal(a.treasuryUsdc);
    expect(b.totalInUsdc).to.equal(a.totalInUsdc);
    expect(b.totalSettledUsdc).to.equal(a.totalSettledUsdc);
    expect(b.totalRefundedUsdc).to.equal(a.totalRefundedUsdc);
    expect(b.paused).to.equal(a.paused);
    expect([...b.quotes.entries()]).to.deep.equal([...a.quotes.entries()]);
    expect([...b.paymentsByTx.entries()]).to.deep.equal([...a.paymentsByTx.entries()]);
    expect([...b.certs.entries()]).to.deep.equal([...a.certs.entries()]);
    expect(replayed.monitor().invariants.ok).to.equal(true);
    // Event logs match too (same canonical history).
    expect(replayed.getEvents().length).to.equal(live.getEvents().length);
  });

  it("a tampered event log fails invariants on load instead of loading silently", () => {
    let t = 1_780_000_000;
    const clock = { now: () => t };
    const live = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = live.issueQuote(POS, {
      sigmaAnnual: 0.6,
      ivRvRatio: 1.08,
      regimeUpdatedAtTs: t,
    });
    live.observePayment({
      txSignature: "txOk",
      referenceKey: quote.referenceKey,
      senderWallet: "buyer1",
      amountUsdc: quote.totalPayableUsdc,
    });

    const events = live.getEvents().map((e) => JSON.parse(JSON.stringify(e)));
    // Tamper: inflate the observed payment amount (steals from conservation).
    const pe = events.find((e: LedgerEvent) => e.kind === "PaymentObserved")!;
    (pe as Extract<LedgerEvent, { kind: "PaymentObserved" }>).payment.amountUsdc += 1_000_000;
    expect(() =>
      CertificateLedger.fromEvents(CONFIG, clock, makeIds(), events),
    ).to.throw(/I2|I3/);
  });
});

describe("@lh/hedge B3: a violating transition never reaches the log", () => {
  it("state mutation that breaks an invariant is rejected AND not persisted", () => {
    const clock = { now: () => 1_780_000_000 };
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const before = ledger.getEvents().length;

    // Force a violation the way a bug would: corrupt the audited totals so
    // conservation (I3) fails, then attempt any further transition.
    (ledger.getState() as { totalInUsdc: number }).totalInUsdc += 12_345;
    expect(() => ledger.setPaused(true)).to.throw(/I3/);

    // The event log must be UNCHANGED — otherwise the next boot replays a
    // poisoned log and the ledger can never load again.
    expect(ledger.getEvents().length).to.equal(before);
    const jsonl = ledger.getEvents().map((e) => JSON.stringify(e)).join("\n");
    expect(jsonl).to.not.match(/PausedSet/);
  });
});
