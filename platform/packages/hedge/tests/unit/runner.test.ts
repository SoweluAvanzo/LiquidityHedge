import { expect } from "chai";
import {
  CertificateLedger,
  IdSource,
  LedgerConfig,
  HedgedPositionInput,
  ObservedTransfer,
  sha256Hex,
} from "../../src";
import { runSettlementCycle, RunnerPorts, RunnerConfig } from "../../src/runner";

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
  masterTermsVersion: "0.1-draft",
  masterTermsHash: sha256Hex("t"),
  treasuryAddress: "TREASURYaddr11111111111111111111111111111111",
};

const RUN: RunnerConfig = {
  hotWalletFloatCapUsdc: 50_000_000_000,
  maxDivergenceBps: 100,
  dryRun: false,
};

function makeClock(start = 1_790_000_000) {
  let t = start;
  return { now: () => t, advance: (s: number) => (t += s) };
}
function makeIds(): IdSource {
  let q = 0, r = 0;
  return { quoteId: () => `Q${++q}`, referenceKey: () => `REF${++r}` };
}
function position(mint = "m1"): HedgedPositionInput {
  return {
    positionMint: mint, ownerWallet: "buyer1", whirlpool: "pool",
    liquidity: 1_000_000_000_000n, tickLower: -20000, tickUpper: -18000,
    decimalsA: 9, decimalsB: 6, currentPriceUsd: 150,
  };
}

/** Fake chain ports: queue of transfers, scripted price, recording payouts. */
function makePorts(opts?: {
  priceUsd?: number;
  divergenceBps?: number;
  balance?: number;
  failPayoutFor?: string;
}) {
  const queue: ObservedTransfer[] = [];
  const executed: { to: string; amountUsdc: number; memo: string }[] = [];
  let txn = 0;
  const ports: RunnerPorts = {
    scanPayments: async () => ({ transfers: queue.splice(0), cursor: "cur1" }),
    readSettlementPrice: async () => ({
      priceUsd: opts?.priceUsd ?? 150,
      slot: 1,
      crossCheckPriceUsd: opts?.priceUsd ?? 150,
      divergenceBps: opts?.divergenceBps ?? 0,
    }),
    readAccruedFees: async () => 1_000_000, // $1
    executePayout: async (p) => {
      if (opts?.failPayoutFor && p.memo.includes(opts.failPayoutFor)) {
        throw new Error("rpc exploded");
      }
      executed.push(p);
      return { txSignature: `ptx${++txn}` };
    },
    hotWalletBalanceUsdc: async () => opts?.balance ?? 100_000_000_000,
  };
  return { ports, queue, executed };
}

describe("@lh/hedge settlement runner (production money loop)", () => {
  it("full cycle: pay → activate → expire → settle at price → payout with memo", async () => {
    const clock = makeClock();
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = ledger.issueQuote(position(), {
      sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now(),
    });
    const { ports, queue, executed } = makePorts({ priceUsd: 142 });
    queue.push({
      txSignature: "tx1", referenceKey: quote.referenceKey,
      senderWallet: "buyer1", amountUsdc: quote.totalPayableUsdc,
    });

    const r1 = await runSettlementCycle(ledger, ports, RUN, null);
    expect(r1.activated).to.deep.equal([quote.quoteId]);
    expect(r1.settled).to.have.length(0); // not expired yet
    expect(r1.cursor).to.equal("cur1");

    clock.advance(CONFIG.tenorSeconds + 1);
    const r2 = await runSettlementCycle(ledger, ports, RUN, r1.cursor);
    expect(r2.settled).to.have.length(1);
    const s = r2.settled[0];
    expect(s.amountUsdc).to.be.greaterThan(0);
    expect(s.executedTx).to.match(/^ptx/);
    expect(executed[0].memo).to.equal(`settle:${quote.quoteId}`);
    expect(executed[0].to).to.equal("buyer1");
    expect(r2.invariantsOk).to.equal(true);

    // Re-running the same cycle is a no-op (idempotent, nothing due).
    const r3 = await runSettlementCycle(ledger, ports, RUN, r2.cursor);
    expect(r3.settled).to.have.length(0);
    expect(r3.observedPayments).to.equal(0);
  });

  it("oracle divergence defers settlement (AR-7) and settles once price agrees", async () => {
    const clock = makeClock();
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = ledger.issueQuote(position(), {
      sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now(),
    });
    const diverged = makePorts({ divergenceBps: 250 });
    diverged.queue.push({
      txSignature: "tx1", referenceKey: quote.referenceKey,
      senderWallet: "buyer1", amountUsdc: quote.totalPayableUsdc,
    });
    await runSettlementCycle(ledger, diverged.ports, RUN, null);
    clock.advance(CONFIG.tenorSeconds + 1);
    const r = await runSettlementCycle(ledger, diverged.ports, RUN, null);
    expect(r.settled).to.have.length(0);
    expect(r.deferredForDivergence).to.deep.equal([
      { quoteId: quote.quoteId, divergenceBps: 250 },
    ]);
    // Price sources agree next cycle → settles.
    const agreed = makePorts({ priceUsd: 145 });
    const r2 = await runSettlementCycle(ledger, agreed.ports, RUN, null);
    expect(r2.settled).to.have.length(1);
  });

  it("refund sweep pays back wrong-amount payments with refund memo", async () => {
    const clock = makeClock();
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = ledger.issueQuote(position(), {
      sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now(),
    });
    const { ports, queue, executed } = makePorts();
    queue.push({
      txSignature: "txWrong", referenceKey: quote.referenceKey,
      senderWallet: "buyer1", amountUsdc: quote.premiumUsdc, // missing collateral
    });
    // Wrong-amount payments can NEVER activate → refundable immediately
    // (Master Terms §4.4); only cap-blocked EXACT payments wait out the TTL.
    const r = await runSettlementCycle(ledger, ports, RUN, null);
    expect(r.refunded).to.have.length(1);
    expect(r.refunded[0].amountUsdc).to.equal(quote.premiumUsdc);
    expect(executed.find((e) => e.memo === "refund:txWrong")).to.not.equal(undefined);
    // And the sweep is idempotent: nothing left to refund next cycle.
    clock.advance(CONFIG.quoteTtlSeconds + 1);
    const r2 = await runSettlementCycle(ledger, ports, RUN, null);
    expect(r2.refunded).to.have.length(0);
  });

  it("float shortfall halts payouts and reports the gap (RB-2)", async () => {
    const clock = makeClock();
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = ledger.issueQuote(position(), {
      sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now(),
    });
    const { ports, queue, executed } = makePorts({ balance: 1_000 }); // dust float
    queue.push({
      txSignature: "tx1", referenceKey: quote.referenceKey,
      senderWallet: "buyer1", amountUsdc: quote.totalPayableUsdc,
    });
    await runSettlementCycle(ledger, ports, RUN, null);
    clock.advance(CONFIG.tenorSeconds + 1);
    const r = await runSettlementCycle(ledger, ports, RUN, null);
    expect(r.floatShortfallUsdc).to.be.greaterThan(0);
    expect(executed).to.have.length(0); // nothing executed
    expect(r.settled[0].executedTx).to.equal(null); // recorded for retry
  });

  it("dryRun plans but never executes", async () => {
    const clock = makeClock();
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = ledger.issueQuote(position(), {
      sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now(),
    });
    const { ports, queue, executed } = makePorts();
    queue.push({
      txSignature: "tx1", referenceKey: quote.referenceKey,
      senderWallet: "buyer1", amountUsdc: quote.totalPayableUsdc,
    });
    await runSettlementCycle(ledger, ports, { ...RUN, dryRun: true }, null);
    clock.advance(CONFIG.tenorSeconds + 1);
    const r = await runSettlementCycle(ledger, ports, { ...RUN, dryRun: true }, null);
    expect(r.settled).to.have.length(1);
    expect(r.settled[0].executedTx).to.equal(null);
    expect(executed).to.have.length(0);
  });

  it("payout failure after ledger transition lands in failedPayouts for ops retry", async () => {
    const clock = makeClock();
    const ledger = new CertificateLedger(CONFIG, clock, makeIds(), 100_000_000_000);
    const quote = ledger.issueQuote(position(), {
      sigmaAnnual: 0.6, ivRvRatio: 1.08, regimeUpdatedAtTs: clock.now(),
    });
    const { ports, queue } = makePorts({ failPayoutFor: "settle:" });
    queue.push({
      txSignature: "tx1", referenceKey: quote.referenceKey,
      senderWallet: "buyer1", amountUsdc: quote.totalPayableUsdc,
    });
    await runSettlementCycle(ledger, ports, RUN, null);
    clock.advance(CONFIG.tenorSeconds + 1);
    const r = await runSettlementCycle(ledger, ports, RUN, null);
    expect(r.failedPayouts).to.have.length(1);
    expect(r.failedPayouts[0].error).to.match(/rpc exploded/);
    // Ledger already recorded the settlement — the monitor keeps invariants.
    expect(r.invariantsOk).to.equal(true);
  });
});
