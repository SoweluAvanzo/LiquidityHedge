/**
 * Hedge Effectiveness Tests
 *
 * Proves that the corridor hedge certificate reduces LP downside risk.
 * Each test creates a fresh protocol, buys a certificate, settles at
 * a specific price, and compares hedged vs unhedged LP outcomes.
 *
 * Position parameters: L=50, S_0=$150, p_l=$135, p_u=$165, cap~$4.46
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
  CertificateStatus,
  clPositionValue,
  naturalCap,
  corridorPayoff,
} from "../../protocol-src/index";
import { DEFAULT_POOL_CONFIG, DEFAULT_TEMPLATE } from "../../protocol-src/config/templates";
import {
  setupTestProtocol,
  generateGbmPath,
  simulateWeeklyFees,
  createRng,
} from "../helpers";

// ---------------------------------------------------------------------------
// Position constants (from helpers.ts defaults)
// ---------------------------------------------------------------------------

const S0 = 150;          // entry price
const L = 50;            // liquidity
const PL = 135;          // lower bound = barrier
const PU = 165;          // upper bound
const V0 = clPositionValue(S0, L, PL, PU);
const CAP = naturalCap(S0, L, PL, PU);

// ---------------------------------------------------------------------------
// Helper: buy certificate and settle at a given price
// ---------------------------------------------------------------------------

function buyAndSettle(settlementPrice: number, feesUsdc: number = 1_000_000) {
  const { protocol } = setupTestProtocol();
  const cert = protocol.buyCertificate("lp-wallet-1", {
    positionMint: "pos-mint-1",
    templateId: 1,
  });
  const result = protocol.settleCertificate(
    "settler",
    "pos-mint-1",
    Math.floor(settlementPrice * 1_000_000),
    feesUsdc,
    cert.expiryTs,
  );
  return { cert, result, protocol };
}

// ---------------------------------------------------------------------------
// Helper: compute unhedged IL in USD
// ---------------------------------------------------------------------------

function unhedgedIL(ST: number): number {
  const VT = clPositionValue(ST, L, PL, PU);
  return V0 - VT; // positive means loss
}

describe("Hedge Effectiveness", () => {

  // ── Test 1: Moderate 5% drop ──────────────────────────────
  it("Moderate drop (5%): hedged LP has lower loss than unhedged", () => {
    const ST = 142.50; // -5%
    const { cert, result } = buyAndSettle(ST);

    const premiumUsd = cert.premiumUsdc / 1_000_000;
    const payoutUsd = result.payoutUsdc / 1_000_000;
    const ilUnhedged = unhedgedIL(ST);
    const ilHedged = ilUnhedged + premiumUsd - payoutUsd;

    expect(ilUnhedged).to.be.greaterThan(0, "unhedged LP has a loss");
    expect(payoutUsd).to.be.greaterThan(0, "payout is positive for a drop");
    expect(ilHedged).to.be.lessThan(
      ilUnhedged,
      "hedged loss must be strictly less than unhedged loss",
    );
  });

  // ── Test 2: Severe 10% drop (barrier hit) ─────────────────
  it("Severe drop (10%, hits barrier): hedged LP loss capped", () => {
    const ST = 135; // exactly at barrier
    const { cert, result } = buyAndSettle(ST);

    const premiumUsd = cert.premiumUsdc / 1_000_000;
    const payoutUsd = result.payoutUsdc / 1_000_000;
    const capUsd = cert.capUsdc / 1_000_000;

    // At the barrier the payout should be the full cap
    expect(payoutUsd).to.be.closeTo(capUsd, 0.01);

    // Hedged net loss = IL + premium - payout
    const ilUnhedged = unhedgedIL(ST);
    const ilHedged = ilUnhedged + premiumUsd - payoutUsd;

    // The cap fully compensates the IL within the corridor,
    // so hedged loss should be approximately the premium cost only
    expect(ilHedged).to.be.closeTo(premiumUsd, 0.02);
    expect(ilHedged).to.be.lessThan(ilUnhedged);
  });

  // ── Test 3: Price up 5% → cost bounded to premium ─────────
  it("Price up 5%: hedge cost is bounded to premium", () => {
    const ST = 157.50; // +5%
    const { cert, result } = buyAndSettle(ST);

    expect(result.payoutUsdc).to.equal(0, "no payout when price rises");
    expect(result.state).to.equal(CertificateStatus.Expired);

    // The only cost to the hedged LP is the premium
    const premiumUsd = cert.premiumUsdc / 1_000_000;
    const hedgeCost = premiumUsd; // premium paid, no payout received

    // Hedge cost is bounded and small relative to cap
    const capUsd = cert.capUsdc / 1_000_000;
    expect(hedgeCost).to.be.lessThan(capUsd);
    expect(hedgeCost).to.be.greaterThan(0);
  });

  // ── Test 4: Price flat → premium is small relative to V ───
  it("Price flat: premium is small cost relative to position value", () => {
    const { protocol } = setupTestProtocol();
    const cert = protocol.buyCertificate("lp-wallet-1", {
      positionMint: "pos-mint-1",
      templateId: 1,
    });

    const premiumUsd = cert.premiumUsdc / 1_000_000;
    const positionValueUsd = V0;

    // Premium should be less than 5% of position value
    expect(premiumUsd / positionValueUsd).to.be.lessThan(0.05);

    // Settle at entry price: no payout
    const result = protocol.settleCertificate(
      "settler",
      "pos-mint-1",
      150_000_000,
      1_000_000,
      cert.expiryTs,
    );
    expect(result.payoutUsdc).to.equal(0);
    expect(result.state).to.equal(CertificateStatus.Expired);
  });

  // ── Test 5: Multi-week simulation ─────────────────────────
  it("Multi-week simulation: hedged LP has lower variance", () => {
    const WEEKS = 20;
    const sigma = 0.65;
    const prices = generateGbmPath(S0, sigma, WEEKS, 42);

    const unhedgedPnLs: number[] = [];
    const hedgedPnLs: number[] = [];

    for (let w = 0; w < WEEKS; w++) {
      // Fresh protocol for each week
      const protocol = new OffchainLhProtocol();
      protocol.initPool("admin", DEFAULT_POOL_CONFIG);
      protocol.depositUsdc("rt-wallet-1", 100_000_000);
      protocol.createTemplate("admin", { ...DEFAULT_TEMPLATE });
      protocol.updateRegimeSnapshot("risk-service", {
        sigmaPpm: 650_000,
        sigma7dPpm: 682_500,
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.08,
      });

      const mint = `pos-week-${w}`;
      protocol.registerLockedPosition("lp-wallet-1", {
        positionMint: mint,
        entryPriceE6: Math.floor(prices[w] * 1_000_000),
        lowerTick: -1000,
        upperTick: 1000,
        liquidity: BigInt(50),
        entryValueE6: 6_000_000,
      });

      const cert = protocol.buyCertificate("lp-wallet-1", {
        positionMint: mint,
        templateId: 1,
      });

      const ST = prices[w + 1];
      const settlePriceE6 = Math.floor(ST * 1_000_000);
      const fees = simulateWeeklyFees(6.0, 0.005, w + 100);

      const settleResult = protocol.settleCertificate(
        "settler",
        mint,
        settlePriceE6,
        fees,
        cert.expiryTs,
      );

      // Compute PnL for this week
      const weekEntry = prices[w];
      const weekPL = weekEntry * 0.90;
      const weekPU = weekEntry * 1.10;
      const vStart = clPositionValue(weekEntry, L, weekPL, weekPU);
      const vEnd = clPositionValue(ST, L, weekPL, weekPU);

      const unhedgedPnL = vEnd - vStart; // negative if price dropped
      const hedgedPnL =
        unhedgedPnL - cert.premiumUsdc / 1_000_000 + settleResult.payoutUsdc / 1_000_000;

      unhedgedPnLs.push(unhedgedPnL);
      hedgedPnLs.push(hedgedPnL);
    }

    // Compute standard deviations
    function stddev(arr: number[]): number {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const variance =
        arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
      return Math.sqrt(variance);
    }

    const unhedgedStd = stddev(unhedgedPnLs);
    const hedgedStd = stddev(hedgedPnLs);

    expect(hedgedStd).to.be.lessThan(
      unhedgedStd,
      `hedged std (${hedgedStd.toFixed(4)}) should be < unhedged std (${unhedgedStd.toFixed(4)})`,
    );
  });

  // ── Test 6: Payout compensates IL within corridor ─────────
  it("Summary: payout exactly compensates IL within corridor", () => {
    // Test at several prices between barrier ($135) and entry ($150)
    const testPrices = [136, 138, 140, 142, 144, 146, 148, 149];

    for (const ST of testPrices) {
      const { cert, result } = buyAndSettle(ST);

      const payoutUsd = result.payoutUsdc / 1_000_000;
      const actualIL = unhedgedIL(ST); // V(S_0) - V(S_T)

      // Within the corridor (barrier < ST < S0), the corridor payoff
      // should equal the actual IL: payout = V(S0) - V(ST)
      // They should match to within rounding tolerance
      expect(payoutUsd).to.be.closeTo(
        actualIL,
        0.02,
        `At S_T=${ST}: payout (${payoutUsd.toFixed(4)}) should match IL (${actualIL.toFixed(4)})`,
      );
    }
  });
});
