import { expect } from "chai";
import { integerSqrt, tickToSqrtPriceX64, sqrtPriceX64ToPrice } from "../../protocol-src/utils/math";
import {
  clPositionValue,
  estimateTokenAmounts,
  naturalCap,
  corridorPayoff,
} from "../../protocol-src/utils/position-value";
import { Q64 } from "../../protocol-src/types";

describe("CL Math Utilities", () => {
  // ── Integer square root ───────────────────────────────────

  describe("integerSqrt", () => {
    it("sqrt(0) = 0", () => {
      expect(integerSqrt(0n)).to.equal(0n);
    });

    it("sqrt(1) = 1", () => {
      expect(integerSqrt(1n)).to.equal(1n);
    });

    it("sqrt(4) = 2", () => {
      expect(integerSqrt(4n)).to.equal(2n);
    });

    it("sqrt(100) = 10", () => {
      expect(integerSqrt(100n)).to.equal(10n);
    });

    it("floor(sqrt(2)) = 1", () => {
      expect(integerSqrt(2n)).to.equal(1n);
    });

    it("floor(sqrt(1000000)) = 1000", () => {
      expect(integerSqrt(1_000_000n)).to.equal(1_000n);
    });

    it("handles large values (10^18)", () => {
      const n = 1_000_000_000_000_000_000n;
      expect(integerSqrt(n)).to.equal(1_000_000_000n);
    });
  });

  // ── CL value function V(S) ────────────────────────────────

  describe("clPositionValue", () => {
    const L = 10_000;
    const pL = 135; // S0 * 0.90
    const pU = 165; // S0 * 1.10
    const S0 = 150;

    it("V(S0) > 0 for in-range position", () => {
      const v = clPositionValue(S0, L, pL, pU);
      expect(v).to.be.greaterThan(0);
    });

    it("V(S) is constant above range (all token B)", () => {
      const v1 = clPositionValue(200, L, pL, pU);
      const v2 = clPositionValue(300, L, pL, pU);
      expect(Math.abs(v1 - v2)).to.be.lessThan(0.001);
    });

    it("V(S) is linear below range (all token A)", () => {
      const v1 = clPositionValue(100, L, pL, pU);
      const v2 = clPositionValue(50, L, pL, pU);
      // v(100) / v(50) should ≈ 100/50 = 2
      expect(v1 / v2).to.be.closeTo(2, 0.01);
    });

    it("V(S) is continuous at lower boundary p_l", () => {
      const vBelow = clPositionValue(pL - 0.001, L, pL, pU);
      const vAt = clPositionValue(pL, L, pL, pU);
      const vAbove = clPositionValue(pL + 0.001, L, pL, pU);
      expect(Math.abs(vBelow - vAt)).to.be.lessThan(0.5);
      expect(Math.abs(vAt - vAbove)).to.be.lessThan(0.5);
    });

    it("V(S) is continuous at upper boundary p_u", () => {
      const vBelow = clPositionValue(pU - 0.001, L, pL, pU);
      const vAt = clPositionValue(pU, L, pL, pU);
      const vAbove = clPositionValue(pU + 0.001, L, pL, pU);
      expect(Math.abs(vBelow - vAt)).to.be.lessThan(0.5);
      expect(Math.abs(vAt - vAbove)).to.be.lessThan(0.5);
    });

    it("V(S) is concave in range (midpoint above chord)", () => {
      const S1 = 140;
      const S2 = 160;
      const Smid = (S1 + S2) / 2;
      const vMid = clPositionValue(Smid, L, pL, pU);
      const vChord = (clPositionValue(S1, L, pL, pU) + clPositionValue(S2, L, pL, pU)) / 2;
      expect(vMid).to.be.greaterThanOrEqual(vChord);
    });

    it("V(S0) > V(pL) (entry value exceeds barrier value)", () => {
      const v0 = clPositionValue(S0, L, pL, pU);
      const vB = clPositionValue(pL, L, pL, pU);
      expect(v0).to.be.greaterThan(vB);
    });
  });

  // ── Natural cap ───────────────────────────────────────────

  describe("naturalCap", () => {
    it("cap > 0 when S0 > pL", () => {
      const cap = naturalCap(150, 10_000, 135, 165);
      expect(cap).to.be.greaterThan(0);
    });

    it("cap = 0 when L = 0", () => {
      const cap = naturalCap(150, 0, 135, 165);
      expect(cap).to.equal(0);
    });

    it("cap increases with liquidity", () => {
      const cap1 = naturalCap(150, 5_000, 135, 165);
      const cap2 = naturalCap(150, 10_000, 135, 165);
      expect(cap2).to.be.greaterThan(cap1);
    });
  });

  // ── Corridor payoff ───────────────────────────────────────

  describe("corridorPayoff", () => {
    const L = 10_000;
    const pL = 135;
    const pU = 165;
    const S0 = 150;
    const cap = naturalCap(S0, L, pL, pU);

    it("payoff = 0 when settlement >= entry", () => {
      expect(corridorPayoff(160, S0, L, pL, pU, cap)).to.equal(0);
      expect(corridorPayoff(S0, S0, L, pL, pU, cap)).to.equal(0);
    });

    it("0 < payoff < cap for partial loss (barrier < ST < entry)", () => {
      const payout = corridorPayoff(142, S0, L, pL, pU, cap);
      expect(payout).to.be.greaterThan(0);
      expect(payout).to.be.lessThan(cap);
    });

    it("payoff = cap when ST <= barrier", () => {
      const payoutAtBarrier = corridorPayoff(pL, S0, L, pL, pU, cap);
      expect(payoutAtBarrier).to.be.closeTo(cap, 0.01);

      const payoutBelowBarrier = corridorPayoff(100, S0, L, pL, pU, cap);
      expect(payoutBelowBarrier).to.be.closeTo(cap, 0.01);
    });

    it("payoff is monotonically increasing as price drops", () => {
      const prices = [149, 146, 143, 140, 137, 135];
      let prevPayout = 0;
      for (const p of prices) {
        const payout = corridorPayoff(p, S0, L, pL, pU, cap);
        expect(payout).to.be.greaterThanOrEqual(prevPayout);
        prevPayout = payout;
      }
    });
  });

  // ── Token amounts ─────────────────────────────────────────

  describe("estimateTokenAmounts", () => {
    const L = BigInt(10_000_000);
    // Use approximate sqrt prices for a ±10% range around $150
    const sqrtLower = BigInt(Math.floor(Math.sqrt(135 / 1000) * Number(Q64)));
    const sqrtUpper = BigInt(Math.floor(Math.sqrt(165 / 1000) * Number(Q64)));
    const sqrtMid = BigInt(Math.floor(Math.sqrt(150 / 1000) * Number(Q64)));

    it("below range: amountB = 0", () => {
      const belowSqrt = sqrtLower - 1n;
      const { amountB } = estimateTokenAmounts(L, belowSqrt, sqrtLower, sqrtUpper);
      expect(amountB).to.equal(0n);
    });

    it("above range: amountA = 0", () => {
      const aboveSqrt = sqrtUpper + 1n;
      const { amountA } = estimateTokenAmounts(L, aboveSqrt, sqrtLower, sqrtUpper);
      expect(amountA).to.equal(0n);
    });

    it("in range: both amounts > 0", () => {
      const { amountA, amountB } = estimateTokenAmounts(L, sqrtMid, sqrtLower, sqrtUpper);
      expect(Number(amountA)).to.be.greaterThan(0);
      expect(Number(amountB)).to.be.greaterThan(0);
    });
  });
});
