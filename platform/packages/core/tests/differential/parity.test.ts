/**
 * Differential parity harness — @lh/core vs. the audited prototype.
 *
 * SR-7 gate: the extraction of `protocol-src/` into `@lh/core` must show
 * ZERO behavioral diff. This suite feeds identical randomized inputs to
 * both implementations and asserts exact equality of every economic
 * output (premiums, payoffs, caps, pool accounting, lifecycle results).
 *
 * The prototype is imported directly from ../../../../../lh-protocol —
 * it stays untouched as the reference implementation.
 *
 * Also guards the extraction-specific contracts:
 *   - the quarantined heuristic FV is NOT exported from the barrel
 *   - u128ToNumber enforces the 2^53-1 safe-cast boundary (SR-1)
 */

import { expect } from "chai";

// ── @lh/core (new names) ───────────────────────────────────────────
import {
  computePremium,
  computeFeeDiscount,
  computeQuadratureFV,
  computeQuadratureFV_E6,
  computeQuote,
  QuoteParams,
} from "../../src/pricing-engine/pricing";
import {
  clPositionValue,
  lhPayoff,
  naturalCap,
} from "../../src/pricing-engine/position-value";
import { computeHeuristicFV } from "../../src/pricing-engine/heuristic-fv";
import { u128ToNumber } from "../../src/utils/math";
import { OffchainLhProtocol } from "../../src/index";
import { DEFAULT_POOL_CONFIG, DEFAULT_TEMPLATE } from "../../src/config/templates";

// ── prototype (reference, old names) ───────────────────────────────
import {
  computePremium as protoComputePremium,
  computeFeeDiscount as protoComputeFeeDiscount,
  computeGaussHermiteFV as protoFV,
  computeGaussHermiteFV_E6 as protoFV_E6,
  computeHeuristicFV as protoHeuristicFV,
  computeQuote as protoComputeQuote,
} from "../../../../../lh-protocol/protocol-src/pricing-engine/pricing";
import {
  clPositionValue as protoClPositionValue,
  lhPayoff as protoLhPayoff,
  naturalCap as protoNaturalCap,
} from "../../../../../lh-protocol/protocol-src/pricing-engine/position-value";
import { OffchainLhProtocol as ProtoProtocol } from "../../../../../lh-protocol/protocol-src/index";

import { createRng } from "../helpers";

// ---------------------------------------------------------------------------
// Randomized input generators (seeded — deterministic across runs)
// ---------------------------------------------------------------------------

const rng = createRng(20260707);

function randIn(lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

function randInt(lo: number, hi: number): number {
  return Math.floor(randIn(lo, hi + 1));
}

function randScenario() {
  const S0 = randIn(20, 500);
  const widthBps = [500, 750, 1000, 1500][randInt(0, 3)];
  const w = widthBps / 10_000;
  const pL = S0 * (1 - w);
  const pU = S0 * (1 + w);
  const L = randIn(10, 2_000);
  const sigmaPpm = randInt(200_000, 1_500_000);
  const ST = S0 * Math.exp(randIn(-0.6, 0.6));
  return { S0, widthBps, pL, pU, L, sigmaPpm, ST };
}

function makeQuoteFixtures(s: ReturnType<typeof randScenario>) {
  const entryPriceE6 = Math.floor(s.S0 * 1_000_000);
  const entryValue = clPositionValue(s.S0, s.L, s.pL, s.pU);
  const params: QuoteParams = {
    entryPriceE6,
    notionalUsdc: Math.floor(entryValue * 1_000_000),
    liquidity: s.L,
    pL: s.pL,
    pU: s.pU,
  };
  const template = { ...DEFAULT_TEMPLATE, widthBps: s.widthBps };
  const pool = {
    reservesUsdc: randInt(50_000_000, 10_000_000_000),
    totalShares: 100_000_000,
    activeCapUsdc: 0,
    uMaxBps: 3_000,
    markupFloor: 1.05,
    feeSplitRate: 0.1,
    expectedDailyFee: 0.005,
    premiumFloorUsdc: 1_500_000,
    protocolFeeBps: 150,
    bump: 255,
  };
  const regime = {
    pool: "pool",
    sigmaPpm: s.sigmaPpm,
    sigma7dPpm: Math.floor(s.sigmaPpm * 1.05),
    stressFlag: rng() < 0.2,
    carryBpsPerDay: randInt(0, 20),
    severityPpm: 380_000,
    ivRvRatio: randIn(0.9, 1.5),
    effectiveMarkup: 0, // set below
    updatedAt: 1_760_000_000,
    bump: 255,
  };
  regime.effectiveMarkup = Math.max(pool.markupFloor, regime.ivRvRatio);
  return { params, template, pool, regime };
}

// ---------------------------------------------------------------------------
// 1. Pure-function parity (exact equality, 300 seeded cases each)
// ---------------------------------------------------------------------------

describe("Differential parity: @lh/core ≡ prototype", () => {
  const CASES = 300;

  it("clPositionValue / lhPayoff / naturalCap agree exactly", () => {
    for (let i = 0; i < CASES; i++) {
      const s = randScenario();
      expect(clPositionValue(s.ST, s.L, s.pL, s.pU)).to.equal(
        protoClPositionValue(s.ST, s.L, s.pL, s.pU),
        `clPositionValue case ${i}`,
      );
      expect(lhPayoff(s.ST, s.S0, s.L, s.pL, s.pU)).to.equal(
        protoLhPayoff(s.ST, s.S0, s.L, s.pL, s.pU),
        `lhPayoff case ${i}`,
      );
      expect(naturalCap(s.S0, s.L, s.pL, s.pU)).to.equal(
        protoNaturalCap(s.S0, s.L, s.pL, s.pU),
        `naturalCap case ${i}`,
      );
    }
  });

  it("computeQuadratureFV(_E6) ≡ prototype computeGaussHermiteFV(_E6)", () => {
    for (let i = 0; i < CASES; i++) {
      const s = randScenario();
      const tenor = 604_800 / 31_536_000;
      expect(computeQuadratureFV(s.S0, s.sigmaPpm / 1e6, s.L, s.pL, s.pU, tenor)).to.equal(
        protoFV(s.S0, s.sigmaPpm / 1e6, s.L, s.pL, s.pU, tenor),
        `FV case ${i}`,
      );
      const e6 = (x: number) => Math.floor(x * 1_000_000);
      expect(
        computeQuadratureFV_E6(e6(s.S0), s.sigmaPpm, s.L, e6(s.pL), e6(s.pU), 604_800),
      ).to.equal(
        protoFV_E6(e6(s.S0), s.sigmaPpm, s.L, e6(s.pL), e6(s.pU), 604_800),
        `FV_E6 case ${i}`,
      );
    }
  });

  it("computePremium / computeFeeDiscount agree exactly", () => {
    for (let i = 0; i < CASES; i++) {
      const fv = randInt(0, 5_000_000);
      const markup = randIn(1.0, 1.6);
      const discount = randInt(0, 1_000_000);
      const floor = randInt(0, 2_000_000);
      expect(computePremium(fv, markup, discount, floor)).to.equal(
        protoComputePremium(fv, markup, discount, floor),
        `premium case ${i}`,
      );
      const notional = randInt(1_000_000, 100_000_000);
      const daily = randIn(0.0005, 0.012);
      const y = randIn(0, 0.3);
      const days = randInt(1, 30);
      expect(computeFeeDiscount(notional, daily, y, days)).to.equal(
        protoComputeFeeDiscount(notional, daily, y, days),
        `feeDiscount case ${i}`,
      );
    }
  });

  it("computeQuote agrees exactly (full breakdown deep-equal)", () => {
    for (let i = 0; i < CASES; i++) {
      const s = randScenario();
      const { params, template, pool, regime } = makeQuoteFixtures(s);
      const a = computeQuote(params, template, { ...pool }, { ...regime });
      const b = protoComputeQuote(params, template, { ...pool }, { ...regime });
      expect(a).to.deep.equal(b, `quote case ${i}`);
    }
  });

  it("quarantined computeHeuristicFV ≡ prototype computeHeuristicFV", () => {
    for (let i = 0; i < CASES; i++) {
      const s = randScenario();
      const { template, pool, regime } = makeQuoteFixtures(s);
      const capUsdc = randInt(1, 50_000_000);
      const a = computeHeuristicFV(capUsdc, template, { ...pool }, { ...regime });
      const b = protoHeuristicFV(capUsdc, template, { ...pool }, { ...regime });
      expect(a).to.deep.equal(b, `heuristic case ${i}`);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Full-lifecycle parity via both emulators (50 seeded scenarios)
  // -------------------------------------------------------------------------

  it("full lifecycle (init→deposit→template→regime→register→buy→settle) agrees exactly", () => {
    let bought = 0;
    for (let i = 0; i < 50; i++) {
      const s = randScenario();
      const rtDeposit = randInt(500_000_000, 20_000_000_000); // $500–$20k
      const feesAccrued = randInt(0, 10_000_000);
      const entryPriceE6 = Math.floor(s.S0 * 1_000_000);
      const entryValueE6 = Math.floor(clPositionValue(s.S0, s.L, s.pL, s.pU) * 1_000_000);
      const liquidity = BigInt(Math.floor(s.L));
      const template = { ...DEFAULT_TEMPLATE, widthBps: s.widthBps };
      const regimeParams = {
        sigmaPpm: s.sigmaPpm,
        sigma7dPpm: Math.floor(s.sigmaPpm * 1.05),
        stressFlag: false,
        carryBpsPerDay: 5,
        ivRvRatio: 1.08,
      };
      const positionParams = {
        positionMint: `pos-${i}`,
        entryPriceE6,
        lowerTick: -1000,
        upperTick: 1000,
        liquidity,
        entryValueE6,
      };

      const run = (P: any) => {
        const p = new P();
        p.initPool("admin", DEFAULT_POOL_CONFIG);
        p.depositUsdc("rt", rtDeposit);
        p.createTemplate("admin", template);
        p.updateRegimeSnapshot("risk", regimeParams);
        p.registerLockedPosition("lp", positionParams);
        let buy: any = null;
        let buyErr: string | null = null;
        try {
          buy = p.buyCertificate("lp", { positionMint: `pos-${i}`, templateId: 1 });
        } catch (e: any) {
          buyErr = e.constructor.name;
        }
        if (buyErr) return { buyErr };
        const settle = p.settleCertificate(
          "settler",
          `pos-${i}`,
          Math.floor(s.ST * 1_000_000),
          feesAccrued,
          buy.expiryTs,
        );
        const pool = p.getPoolState()!;
        return {
          premiumUsdc: buy.premiumUsdc,
          protocolFeeUsdc: buy.protocolFeeUsdc,
          capUsdc: buy.capUsdc,
          payoutUsdc: settle.payoutUsdc,
          rtFeeIncomeUsdc: settle.rtFeeIncomeUsdc,
          state: settle.state,
          reservesUsdc: pool.reservesUsdc,
          activeCapUsdc: pool.activeCapUsdc,
          totalShares: pool.totalShares,
        };
      };

      const a = run(OffchainLhProtocol);
      const b = run(ProtoProtocol);
      expect(a).to.deep.equal(b, `lifecycle case ${i}`);
      if (!("buyErr" in a)) bought++;
    }
    // The harness is vacuous if every buy was refused — require real coverage.
    expect(bought).to.be.greaterThan(25, "too few successful purchases to be meaningful");
  });

  // -------------------------------------------------------------------------
  // 3. Extraction-specific contracts
  // -------------------------------------------------------------------------

  it("heuristic FV is NOT exported from the @lh/core barrel", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const barrel = require("../../src/index");
    expect(barrel.computeHeuristicFV).to.equal(undefined);
    expect(barrel.computeQuadratureFV).to.be.a("function");
  });

  it("u128ToNumber enforces the 2^53−1 boundary (SR-1)", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(u128ToNumber(max)).to.equal(Number.MAX_SAFE_INTEGER);
    expect(u128ToNumber(0n)).to.equal(0);
    expect(() => u128ToNumber(max + 1n)).to.throw(/exceeds 2\^53-1/);
    expect(() => u128ToNumber(-1n)).to.throw(/negative/);
  });
});
