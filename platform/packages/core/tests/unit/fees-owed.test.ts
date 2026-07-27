/**
 * Real uncollected fees — the calculation that replaces the stale
 * `feeOwedA/B` checkpoint the dashboard used to display as "0 SOL + 0
 * USDC" on positions that had obviously earned fees.
 *
 * The two things worth pinning are the SIDE FLIP (fee_growth_outside
 * changes meaning as the price crosses a tick) and WRAP SAFETY (these are
 * mod-2^128 accumulators; a signed subtraction across a wrap yields an
 * astronomically wrong payout).
 */

import { expect } from "chai";
import {
  feeGrowthInside,
  uncollectedFees,
  wrapSub,
} from "../../src/market-data/fees-owed";

const Q64 = 1n << 64n;
const U128 = 1n << 128n;
/** Q64.64 helper: `n` whole units of fee growth per unit of liquidity. */
const g = (n: bigint) => n * Q64;

describe("@lh/core uncollected fees", () => {
  describe("wrapSub", () => {
    it("is plain subtraction when no wrap occurred", () => {
      expect(wrapSub(500n, 200n)).to.equal(300n);
    });

    it("handles a wrapped accumulator", () => {
      // Counter wrapped past 2^128: later is small, earlier is huge.
      const earlier = U128 - 10n;
      const later = 5n; // wrapped around, 15 units of real growth
      expect(wrapSub(later, earlier)).to.equal(15n);
    });

    it("never returns a negative or out-of-range value", () => {
      for (const [l, e] of [
        [0n, U128 - 1n],
        [U128 - 1n, 0n],
        [12345n, 12345n],
      ] as const) {
        const d = wrapSub(l, e);
        // chai's ordering assertions reject BigInt, so compare directly.
        expect(d >= 0n, `${d} >= 0`).to.equal(true);
        expect(d < U128, `${d} < 2^128`).to.equal(true);
      }
    });
  });

  describe("feeGrowthInside — the side flip", () => {
    const base = {
      tickLowerIndex: -100,
      tickUpperIndex: 100,
      feeGrowthGlobalA: g(1000n),
      feeGrowthGlobalB: g(2000n),
      lowerOutsideA: g(100n),
      lowerOutsideB: g(200n),
      upperOutsideA: g(300n),
      upperOutsideB: g(400n),
    };

    it("price INSIDE the range: inside = global − lower − upper", () => {
      const { insideA, insideB } = feeGrowthInside({ ...base, tickCurrentIndex: 0 });
      expect(insideA).to.equal(g(1000n - 100n - 300n));
      expect(insideB).to.equal(g(2000n - 200n - 400n));
    });

    it("price BELOW the range: the lower tick's outside flips", () => {
      // below = global − lowerOutside ; above = upperOutside
      // inside = global − (global − 100) − 300 = 100 − 300 → wraps negative
      const { insideA } = feeGrowthInside({ ...base, tickCurrentIndex: -500 });
      expect(insideA).to.equal(wrapSub(g(100n), g(300n)));
    });

    it("price ABOVE the range: the upper tick's outside flips", () => {
      // below = lowerOutside ; above = global − upperOutside
      // inside = global − 100 − (global − 300) = 300 − 100 = 200
      const { insideA } = feeGrowthInside({ ...base, tickCurrentIndex: 500 });
      expect(insideA).to.equal(g(200n));
    });

    it("boundary: tickCurrent == tickLower counts as inside", () => {
      const at = feeGrowthInside({ ...base, tickCurrentIndex: -100 });
      const inside = feeGrowthInside({ ...base, tickCurrentIndex: 0 });
      expect(at.insideA).to.equal(inside.insideA);
    });

    it("boundary: tickCurrent == tickUpper counts as ABOVE (upper is exclusive)", () => {
      const at = feeGrowthInside({ ...base, tickCurrentIndex: 100 });
      const above = feeGrowthInside({ ...base, tickCurrentIndex: 500 });
      expect(at.insideA).to.equal(above.insideA);
    });
  });

  describe("uncollectedFees", () => {
    it("returns the checkpoint alone when nothing accrued since", () => {
      const r = uncollectedFees({
        liquidity: 1_000_000n,
        feeOwedA: 42n,
        feeOwedB: 7n,
        feeGrowthCheckpointA: g(500n),
        feeGrowthCheckpointB: g(500n),
        insideA: g(500n),
        insideB: g(500n),
      });
      expect(r.feesA).to.equal(42n);
      expect(r.feesB).to.equal(7n);
    });

    it("adds L × Δgrowth / 2^64 on top of the checkpoint", () => {
      // This is the case the dashboard was getting wrong: checkpoint 0,
      // real growth since. Reporting feeOwed alone would show zero.
      const r = uncollectedFees({
        liquidity: 2_000_000n,
        feeOwedA: 0n,
        feeOwedB: 0n,
        feeGrowthCheckpointA: g(100n),
        feeGrowthCheckpointB: g(100n),
        insideA: g(103n), // 3 units of growth per unit of liquidity
        insideB: g(105n),
      });
      expect(r.feesA).to.equal(2_000_000n * 3n);
      expect(r.feesB).to.equal(2_000_000n * 5n);
      expect(r.feesA > 0n).to.equal(true); // the reported symptom
    });

    it("is wrap-safe: a wrapped accumulator does not explode the payout", () => {
      const checkpoint = U128 - g(2n); // near the top of the range
      const inside = g(1n); // wrapped past zero: 3 units of real growth
      const r = uncollectedFees({
        liquidity: 1_000_000n,
        feeOwedA: 0n,
        feeOwedB: 0n,
        feeGrowthCheckpointA: checkpoint,
        feeGrowthCheckpointB: checkpoint,
        insideA: inside,
        insideB: inside,
      });
      expect(r.feesA).to.equal(3_000_000n);
      // A signed subtraction here would have produced ~1e33.
      expect(r.feesA < 10_000_000n).to.equal(true);
    });

    it("truncates like the on-chain program (integer division)", () => {
      const r = uncollectedFees({
        liquidity: 3n,
        feeOwedA: 0n,
        feeOwedB: 0n,
        feeGrowthCheckpointA: 0n,
        feeGrowthCheckpointB: 0n,
        insideA: Q64 / 2n, // half a unit each → 1.5 → truncates to 1
        insideB: Q64 / 2n,
      });
      expect(r.feesA).to.equal(1n);
    });

    it("zero liquidity earns nothing beyond its checkpoint", () => {
      const r = uncollectedFees({
        liquidity: 0n,
        feeOwedA: 11n,
        feeOwedB: 13n,
        feeGrowthCheckpointA: 0n,
        feeGrowthCheckpointB: 0n,
        insideA: g(9999n),
        insideB: g(9999n),
      });
      expect(r.feesA).to.equal(11n);
      expect(r.feesB).to.equal(13n);
    });
  });

  it("end-to-end: an untouched in-range position reports real fees", () => {
    // The exact shape of the bug report: feeOwed = 0, checkpoint written
    // when the position was opened, price in range ever since.
    const inside = feeGrowthInside({
      tickCurrentIndex: 0,
      tickLowerIndex: -1000,
      tickUpperIndex: 1000,
      feeGrowthGlobalA: g(5000n),
      feeGrowthGlobalB: g(9000n),
      lowerOutsideA: g(1000n),
      lowerOutsideB: g(2000n),
      upperOutsideA: g(500n),
      upperOutsideB: g(1000n),
    });
    const fees = uncollectedFees({
      liquidity: 62_750_613n, // a real position's liquidity
      feeOwedA: 0n,
      feeOwedB: 0n,
      feeGrowthCheckpointA: g(3000n),
      feeGrowthCheckpointB: g(5000n),
      insideA: inside.insideA,
      insideB: inside.insideB,
    });
    // inside = 5000-1000-500 = 3500 ; Δ = 500 → 500 × L
    expect(fees.feesA).to.equal(62_750_613n * 500n);
    // inside = 9000-2000-1000 = 6000 ; Δ = 1000 → 1000 × L
    expect(fees.feesB).to.equal(62_750_613n * 1000n);
  });
});
