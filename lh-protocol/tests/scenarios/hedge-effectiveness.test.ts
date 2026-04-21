/**
 * Hedge Effectiveness Tests
 *
 * Proves that the Liquidity Hedge certificate replicates IL within
 * the active range [p_l, p_u]. Each test creates a fresh protocol,
 * buys a certificate, settles at a specific price, and compares
 * hedged vs unhedged LP outcomes.
 *
 * Under the signed-swap design:
 *   - Below S_0: payout > 0 (RT owes LP)
 *   - Above S_0: payout < 0 (LP surrenders upside to RT)
 *
 * Position parameters: L=50, S_0=$150, p_l=$135, p_u=$165
 */

import { expect } from "chai";
import {
  OffchainLhProtocol,
  CertificateStatus,
  clPositionValue,
  naturalCap,
  naturalCapUp,
  lhPayoff,
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
const CAP_DOWN = naturalCap(S0, L, PL, PU);
const CAP_UP = naturalCapUp(S0, L, PL, PU);

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

  // ── Test 2: Severe 10% drop (lower bound hit) ────────────
  it("Severe drop (10%, hits p_l): payout = +Cap_down, LP locked at V(S_0)", () => {
    const ST = 135; // exactly at p_l
    const { cert, result } = buyAndSettle(ST);

    const premiumUsd = cert.premiumUsdc / 1_000_000;
    const payoutUsd = result.payoutUsdc / 1_000_000;
    const capDownUsd = cert.capUsdc / 1_000_000;

    // At the lower bound the payout equals Cap_down
    expect(payoutUsd).to.be.closeTo(capDownUsd, 0.01);

    // Hedged net loss = IL + premium - payout
    const ilUnhedged = unhedgedIL(ST);
    const ilHedged = ilUnhedged + premiumUsd - payoutUsd;

    // Within [p_l, p_u], Π exactly replicates IL, so hedged LP's net
    // loss is just the premium
    expect(ilHedged).to.be.closeTo(premiumUsd, 0.02);
    expect(ilHedged).to.be.lessThan(ilUnhedged);
  });

  // ── Test 3: Price up 5% → LP surrenders upside to RT ─────
  it("Price up 5%: LP pays RT the upside give-up (swap semantics)", () => {
    const ST = 157.50; // +5%
    const { cert, result } = buyAndSettle(ST);

    const premiumUsd = cert.premiumUsdc / 1_000_000;
    const payoutUsd = result.payoutUsdc / 1_000_000;

    // Under the swap, upside inside the active range is surrendered:
    // payout is NEGATIVE and equals V(S_0) − V(S_T) < 0
    const expectedPayout = V0 - clPositionValue(ST, L, PL, PU);
    expect(payoutUsd).to.be.lessThan(0, "payout is negative for upside");
    expect(payoutUsd).to.be.closeTo(expectedPayout, 0.02);
    expect(result.state).to.equal(CertificateStatus.Settled);

    // LP net within [p_l, p_u] = V(S_0) − premium (locked at entry value)
    const vT = clPositionValue(ST, L, PL, PU);
    const lpNet = vT + payoutUsd - premiumUsd; // position + payoff - premium
    const lpLocked = V0 - premiumUsd;
    expect(lpNet).to.be.closeTo(lpLocked, 0.02);
  });

  // ── Test 3b: Price above upper bound → capped upside give-up ─
  it("Price up >10% (hits p_u): LP surrenders at most Cap_up", () => {
    const ST = 170; // above p_u = 165
    const { cert, result } = buyAndSettle(ST);

    const payoutUsd = result.payoutUsdc / 1_000_000;
    expect(payoutUsd).to.be.closeTo(-CAP_UP, 0.01);
    // Concavity of V guarantees |Cap_up| < Cap_down
    expect(Math.abs(payoutUsd)).to.be.lessThan(CAP_DOWN);
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

  // ── Test 6: Payout exactly replicates V(S_0) − V(S_T) in [p_l, p_u] ─
  it("Exact IL replication: Π = V(S_0) − V(S_T) within [p_l, p_u]", () => {
    // Both sides of S_0 within the active range
    const testPrices = [136, 140, 144, 148, 150, 152, 156, 160, 164];

    for (const ST of testPrices) {
      const { cert, result } = buyAndSettle(ST);

      const payoutUsd = result.payoutUsdc / 1_000_000;
      const expected = V0 - clPositionValue(ST, L, PL, PU); // signed

      expect(payoutUsd).to.be.closeTo(
        expected,
        0.02,
        `At S_T=${ST}: payout ${payoutUsd.toFixed(4)} should equal V(S_0)−V(S_T) = ${expected.toFixed(4)}`,
      );
    }
  });
});
