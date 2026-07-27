import { expect } from "chai";
import {
  PositionFeeSnapshot,
  measurePositionFees,
} from "../../src/position-fees";

const Q64 = 1n << 64n;
const U128 = 1n << 128n;

/** Snapshot with inside-growth in native-units-per-L (scaled by Q64). */
function snap(
  t: number,
  price: number,
  insideA: bigint,
  insideB: bigint,
  opts?: { liq?: bigint; inRange?: boolean },
): PositionFeeSnapshot {
  return {
    t,
    whirlpool: "POOL",
    liquidity: (opts?.liq ?? 10n ** 6n).toString(),
    feeGrowthInsideA: (insideA % U128).toString(),
    feeGrowthInsideB: (insideB % U128).toString(),
    price,
    inRange: opts?.inRange ?? true,
  };
}

describe("@lh/market-data position fees (§1.2 realised yield)", () => {
  const DEC_A = 9;
  const DEC_B = 6;

  it("computes L × Δinside / 2⁶⁴ exactly, valued at the interval mid price", () => {
    // Interval 1: ΔinsideA = 1000/L → 1e9 native = 1 SOL at mid $100 = $100;
    //             ΔinsideB = 50/L → 5e7 native = $50.
    // Interval 2: ΔinsideA = 0; ΔinsideB = 150/L → $150.
    const s = [
      snap(0, 95, 0n, 0n),
      snap(900, 105, 1000n * Q64, 50n * Q64),
      snap(1800, 105, 1000n * Q64, 200n * Q64),
    ];
    const r = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(r.intervals).to.equal(2);
    expect(r.feesA).to.equal(1_000_000_000n);
    expect(r.feesB).to.equal(200_000_000n);
    expect(r.feesQuote).to.be.closeTo(100 + 50 + 150, 1e-9);
    expect(r.coveredSeconds).to.equal(1800);
    expect(r.inRangeSeconds).to.equal(1800);
  });

  it("an out-of-range stretch legitimately earns zero — measured, not modelled", () => {
    const s = [
      snap(0, 80, 500n * Q64, 500n * Q64, { inRange: false }),
      snap(900, 80, 500n * Q64, 500n * Q64, { inRange: false }),
    ];
    const r = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(r.feesQuote).to.equal(0);
    expect(r.inRangeSeconds).to.equal(0);
    expect(r.intervals).to.equal(1);
  });

  it("range crossings weight in-range time by half", () => {
    const s = [
      snap(0, 100, 0n, 0n, { inRange: true }),
      snap(900, 100, 10n * Q64, 0n, { inRange: false }),
    ];
    const r = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(r.inRangeSeconds).to.equal(450);
  });

  it("a liquidity change makes the interval's attribution ambiguous — skipped", () => {
    const s = [
      snap(0, 100, 0n, 0n, { liq: 10n ** 6n }),
      snap(900, 100, 1000n * Q64, 0n, { liq: 2n * 10n ** 6n }), // L changed
      snap(1800, 100, 2000n * Q64, 0n, { liq: 2n * 10n ** 6n }), // clean
    ];
    const r = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(r.liquidityChangeIntervals).to.equal(1);
    expect(r.intervals).to.equal(1);
    // Second interval: Δ=1000/L × L=2e6 = 2e9 native = 2 SOL = $200.
    expect(r.feesQuote).to.be.closeTo(200, 1e-9);
  });

  it("a wrapped/backwards accumulator is rejected, never credited", () => {
    const s = [
      snap(0, 100, 5000n * Q64, 0n),
      snap(900, 100, 10n * Q64, 0n), // backwards → wrap ≈ 2^128 → implausible
      snap(1800, 100, 20n * Q64, 0n), // sane: 10/L × 1e6 = 1e7 native = 0.01 SOL
    ];
    const r = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(r.implausibleIntervals).to.equal(1);
    expect(r.intervals).to.equal(1);
    expect(r.feesQuote).to.be.closeTo(1, 1e-9); // 0.01 SOL × $100
  });

  it("caller-supplied relative ceiling rejects intervals the $1M default would pass", () => {
    // $200 of "fees" in 15 min on a small position: absurd for a $2
    // position, invisible to the absolute default.
    const s = [
      snap(0, 100, 0n, 0n),
      snap(900, 100, 2000n * Q64, 0n), // 2 SOL = $200
      snap(1800, 100, 2000n * Q64, 0n), // quiet interval
    ];
    const loose = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(loose.implausibleIntervals).to.equal(0);
    const strict = measurePositionFees(s, DEC_A, DEC_B, {
      implausibleIntervalFeesQuote: 1, // 0.5 × a $2 position
    })!;
    expect(strict.implausibleIntervals).to.equal(1);
    expect(strict.feesQuote).to.equal(0);
  });

  it("gaps beyond maxGapSeconds are excluded from covered time", () => {
    const s = [
      snap(0, 100, 0n, 0n),
      snap(900, 100, 100n * Q64, 0n),
      snap(900 + 7200, 100, 900n * Q64, 0n), // 2h collector outage
    ];
    const r = measurePositionFees(s, DEC_A, DEC_B)!;
    expect(r.gapIntervals).to.equal(1);
    expect(r.coveredSeconds).to.equal(900);
    expect(r.windowSeconds).to.equal(8100);
  });

  it("§1.7: feesQuoteCi is deterministic, brackets the total, and needs ≥8 intervals", () => {
    const few = Array.from({ length: 5 }, (_, i) => snap(i * 900, 100, BigInt(i * 10) * Q64, 0n));
    expect(measurePositionFees(few, DEC_A, DEC_B)!.feesQuoteCi).to.equal(null);

    const many = Array.from({ length: 20 }, (_, i) =>
      snap(i * 900, 100, BigInt(i * i) * Q64, 0n),
    );
    const a = measurePositionFees(many, DEC_A, DEC_B)!;
    const b = measurePositionFees(many, DEC_A, DEC_B)!;
    expect(a.feesQuoteCi).to.deep.equal(b.feesQuoteCi);
    expect(a.feesQuoteCi!.p05).to.be.at.most(a.feesQuote);
    expect(a.feesQuoteCi!.p95).to.be.at.least(a.feesQuote * 0.5);
  });

  it("returns null when nothing is usable", () => {
    expect(measurePositionFees([], DEC_A, DEC_B)).to.equal(null);
    expect(measurePositionFees([snap(0, 100, 0n, 0n)], DEC_A, DEC_B)).to.equal(null);
  });
});
