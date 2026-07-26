/**
 * Model-based testing: random action sequences mirroring the Quint model's
 * `step` (platform/formal/lh_ledger.qnt). Business rejections (LedgerError)
 * are legal; an InvariantViolation is NEVER legal — it would mean the
 * implementation diverged from the verified design.
 */

import { expect } from "chai";
import {
  CertificateLedger,
  IdSource,
  InvariantViolation,
  LedgerConfig,
  LedgerError,
  HedgedPositionInput,
  checkInvariants,
  sha256Hex,
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
  masterTermsVersion: "0.1-draft",
  masterTermsHash: sha256Hex("master-terms-0.1-draft"),
  treasuryAddress: "TREASURYaddr11111111111111111111111111111111",
};

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("@lh/hedge model-based random sequences (bridge to lh_ledger.qnt)", () => {
  it("300 random 50-step sequences never violate I1–I4", function () {
    this.timeout(120_000);
    let totalActions = 0;
    let activations = 0;
    let settlements = 0;
    let refunds = 0;

    for (let seq = 0; seq < 300; seq++) {
      const rng = mulberry32(1_000_003 * (seq + 1));
      let t = 1_780_000_000;
      const clock = { now: () => t };
      let qn = 0;
      let rn = 0;
      const ids: IdSource = {
        quoteId: () => `s${seq}-Q${++qn}`,
        referenceKey: () => `s${seq}-R${++rn}`,
      };
      // Small positions (L=1e10 → capDown ≈ $28) so many certs fit.
      const ledger = new CertificateLedger(CONFIG, clock, ids, 10_000_000_000); // $10k
      let mintCounter = 0;
      let txCounter = 0;

      const makePos = (): HedgedPositionInput => ({
        positionMint: `s${seq}-mint${++mintCounter}`,
        ownerWallet: `wallet${mintCounter % 5}`,
        whirlpool: "pool",
        liquidity: 10_000_000_000n,
        tickLower: -20000,
        tickUpper: -18000,
        decimalsA: 9,
        decimalsB: 6,
        currentPriceUsd: 140 + rng() * 20, // inside the corridor
      });

      for (let step = 0; step < 50; step++) {
        totalActions++;
        const roll = rng();
        try {
          if (roll < 0.2) {
            ledger.issueQuote(makePos(), {
              sigmaAnnual: 0.3 + rng() * 1.0,
              ivRvRatio: 0.9 + rng() * 0.6,
              regimeUpdatedAtTs: t,
            });
          } else if (roll < 0.45) {
            // Pay a random open quote: exact / wrong / duplicate-tx.
            const open = [...ledger.getState().quotes.values()].filter(
              (q) => q.status === "open",
            );
            if (open.length > 0) {
              const q = open[Math.floor(rng() * open.length)];
              const mode = rng();
              const amount =
                mode < 0.6
                  ? q.totalPayableUsdc
                  : mode < 0.85
                    ? q.premiumUsdc // missing collateral
                    : q.totalPayableUsdc + 1; // overpayment
              const dup = rng() < 0.15 && txCounter > 0;
              const sig = dup ? `s${seq}-tx${txCounter}` : `s${seq}-tx${++txCounter}`;
              const res = ledger.observePayment({
                txSignature: sig,
                referenceKey: q.referenceKey,
                senderWallet: "buyer",
                amountUsdc: amount,
              });
              if (res.activated) activations++;
            }
          } else if (roll < 0.55) {
            // Refund any eligible unmatched payment.
            for (const [sig, p] of ledger.getState().paymentsByTx) {
              if (p.matched) continue;
              try {
                ledger.refundPayment(sig);
                refunds++;
                break;
              } catch (e) {
                if (!(e instanceof LedgerError)) throw e;
              }
            }
          } else if (roll < 0.7) {
            t += Math.floor(rng() * 200); // small time advance (quote TTL scale)
          } else if (roll < 0.8) {
            t += Math.floor(rng() * CONFIG.tenorSeconds * 1.5); // big advance
            ledger.lapseExpiredQuotes();
          } else if (roll < 0.95) {
            const due = ledger.dueForSettlement();
            if (due.length > 0) {
              const c = due[Math.floor(rng() * due.length)];
              const price = 100 + rng() * 100; // anywhere around the corridor
              ledger.settle(
                c.quoteId,
                {
                  priceUsd: price,
                  slot: step,
                  crossCheckPriceUsd: price,
                  divergenceBps: 0,
                },
                Math.floor(rng() * 5_000_000),
              );
              settlements++;
            }
          } else {
            ledger.setPaused(rng() < 0.5);
          }
        } catch (e) {
          if (e instanceof InvariantViolation) {
            throw new Error(
              `INVARIANT VIOLATION seq=${seq} step=${step}: ${e.message}`,
            );
          }
          if (!(e instanceof LedgerError)) throw e; // business rejections are legal
        }
      }

      // End-of-sequence reconciliation (I1–I4 once more, explicitly).
      const report = checkInvariants(ledger.getState());
      expect(report.ok, `seq ${seq}: ${report.failures.join("; ")}`).to.equal(true);
    }

    // The exercise must be REAL — not vacuous rejection storms.
    expect(activations).to.be.greaterThan(300);
    expect(settlements).to.be.greaterThan(100);
    expect(refunds).to.be.greaterThan(50);
    // eslint-disable-next-line no-console
    console.log(
      `      exercised: ${totalActions} actions, ${activations} activations, ` +
        `${settlements} settlements, ${refunds} refunds — no invariant violations`,
    );
  });
});
