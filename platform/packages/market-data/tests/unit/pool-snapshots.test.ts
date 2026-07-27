import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PoolSnapshot,
  computeRangeFeeYield,
  feeGrowthDelta,
  measurePoolDailyYield,
  rangeYieldUsd,
  FilePoolSnapshotStore,
} from "../../src/pool-snapshots";

const Q64 = 1n << 64n;
const U128 = 1n << 128n;

/** Build a snapshot with growth expressed in native-units-per-L (scaled by Q64 internally). */
function snap(t: number, price: number, growthA: bigint, growthB: bigint, liq = 10n ** 12n): PoolSnapshot {
  return {
    t,
    price,
    liquidity: liq.toString(),
    feeGrowthGlobalA: (growthA % U128).toString(),
    feeGrowthGlobalB: (growthB % U128).toString(),
  };
}

describe("@lh/market-data pool snapshots (Tier-C exact yield)", () => {
  const L = 1_000_000n;

  it("fully in range: fees = ΔfeeGrowth × L exactly", () => {
    const s = [
      snap(0, 150, 0n, 0n),
      snap(900, 151, 5n * Q64, 7n * Q64),      // +5/L tokenA, +7/L tokenB
      snap(1800, 149, 9n * Q64, 12n * Q64),    // +4/L, +5/L
    ];
    const r = computeRangeFeeYield(s, 140, 160, L);
    expect(r.feesA).to.equal(9n * L);
    expect(r.feesB).to.equal(12n * L);
    expect(r.inRangeSeconds).to.equal(1800);
    expect(r.crossings).to.equal(0);
  });

  it("fully out of range: zero fees regardless of pool growth", () => {
    const s = [snap(0, 150, 0n, 0n), snap(900, 152, 100n * Q64, 100n * Q64)];
    const r = computeRangeFeeYield(s, 160, 170, L);
    expect(r.feesA).to.equal(0n);
    expect(r.feesB).to.equal(0n);
    expect(r.inRangeSeconds).to.equal(0);
  });

  it("boundary crossing: half weight, counted", () => {
    const s = [snap(0, 150, 0n, 0n), snap(900, 165, 8n * Q64, 4n * Q64)]; // exits range at 160
    const r = computeRangeFeeYield(s, 140, 160, L);
    expect(r.feesA).to.equal(4n * L); // half of 8
    expect(r.feesB).to.equal(2n * L);
    expect(r.crossings).to.equal(1);
    expect(r.inRangeSeconds).to.equal(450);
  });

  it("different ranges over the SAME snapshots give different, independent results", () => {
    // The generalization property: one pool feed serves any hypothetical range.
    const s = [
      snap(0, 150, 0n, 0n),
      snap(900, 158, 6n * Q64, 6n * Q64),
      snap(1800, 170, 10n * Q64, 10n * Q64),
    ];
    const tight = computeRangeFeeYield(s, 149, 151, L); // exits in interval 1, out in 2
    const wide = computeRangeFeeYield(s, 100, 200, L); // always in
    expect(wide.feesA).to.equal(10n * L);
    expect(tight.feesA).to.equal(3n * L); // half of interval-1 growth, none of interval-2
    expect(tight.crossings).to.equal(1);
  });

  it("feeGrowth wrap-around (mod 2^128) is handled", () => {
    const nearMax = U128 - 3n * Q64;
    const s = [snap(0, 150, nearMax, 0n), snap(900, 150, 2n * Q64, 0n)]; // wraps: Δ = 5/L
    const r = computeRangeFeeYield(s, 140, 160, L);
    expect(r.feesA).to.equal(5n * L);
    expect(feeGrowthDelta(2n * Q64, nearMax)).to.equal(5n * Q64);
  });

  it("dilution adjustment shrinks fees for non-marginal hypothetical L", () => {
    const active = 1_000_000n;
    const s = [
      snap(0, 150, 0n, 0n, active),
      snap(900, 150, 10n * Q64, 0n, active),
    ];
    const marginal = computeRangeFeeYield(s, 140, 160, 1000n);
    const bigUndiluted = computeRangeFeeYield(s, 140, 160, active);
    const bigDiluted = computeRangeFeeYield(s, 140, 160, active, { adjustForDilution: true });
    expect(marginal.feesA).to.equal(10n * 1000n);
    expect(bigUndiluted.feesA).to.equal(10n * active);
    expect(bigDiluted.feesA).to.equal((10n * active) / 2n); // L_active/(L_active+L) = 1/2
  });

  it("USD conversion applies decimals and accrual price", () => {
    const r = { feesA: 2_000_000_000n, feesB: 3_000_000n, inRangeSeconds: 0, totalSeconds: 0, intervals: 0, crossings: 0 };
    // 2 SOL-lamports-e9 = 2e9/1e9 = 2 SOL at $75 + $3 USDC = $153
    expect(rangeYieldUsd(r, 75, 9, 6)).to.be.closeTo(2 * 75 + 3, 1e-9);
  });

  describe("measurePoolDailyYield (§1.1 direct measurement)", () => {
    /** decimals 9/6 (SOL/USDC-shaped); growth in native-units-per-L. */
    const DEC_A = 9;
    const DEC_B = 6;
    /** Vaults for a $2M TVL pool at price 100: 10k SOL × $100 + $1M USDC. */
    const vaulted = (
      t: number,
      price: number,
      growthA: bigint,
      growthB: bigint,
      liq = 10n ** 12n,
      vaultA = (10_000n * 10n ** 9n).toString(),
      vaultB = (1_000_000n * 10n ** 6n).toString(),
    ): PoolSnapshot => ({ ...snap(t, price, growthA, growthB, liq), vaultA, vaultB });

    it("computes the documented formula exactly over two intervals", () => {
      const L = 10n ** 6n;
      // Interval 1 (900s): feesA = 1000/L × 1e6 = 1e9 native = 1 SOL = $100;
      //                    feesB = 100/L × 1e6 = 1e8 native = $100. TVL $2M.
      // Interval 2 (900s): feesA = 0; feesB = 300/L × 1e6 = 3e8 native = $300.
      const s = [
        vaulted(0, 100, 0n, 0n, L),
        vaulted(900, 100, 1000n * Q64, 100n * Q64, L),
        vaulted(1800, 100, 1000n * Q64, 400n * Q64, L),
      ];
      const r = measurePoolDailyYield(s, DEC_A, DEC_B)!;
      expect(r.intervals).to.equal(2);
      expect(r.coveredSeconds).to.equal(1800);
      expect(r.feesQuote).to.be.closeTo(200 + 300, 1e-9);
      // rate per interval: 200/2e6 + 300/2e6 = 2.5e-4 over 1800s
      // daily = 2.5e-4 / (1800/86400) = 0.012
      expect(r.dailyYield).to.be.closeTo(0.012, 1e-12);
      expect(r.avgTvlQuote).to.be.closeTo(2_000_000, 1e-6);
    });

    it("token-A fees are valued at the interval mid price", () => {
      const L = 10n ** 6n;
      const s = [
        vaulted(0, 90, 0n, 0n, L),
        vaulted(900, 110, 1000n * Q64, 0n, L), // 1 SOL of fees, mid price $100
      ];
      const r = measurePoolDailyYield(s, DEC_A, DEC_B)!;
      expect(r.feesQuote).to.be.closeTo(100, 1e-9); // 1 SOL × $(90+110)/2
    });

    it("gaps longer than maxGapSeconds are excluded from covered time", () => {
      const L = 10n ** 6n;
      const s = [
        vaulted(0, 100, 0n, 0n, L),
        vaulted(900, 100, 1000n * Q64, 0n, L),          // used: $100
        vaulted(900 + 7200, 100, 9000n * Q64, 0n, L),   // 2h gap: skipped
        vaulted(900 + 7200 + 900, 100, 10_000n * Q64, 0n, L), // used: $100
      ];
      const r = measurePoolDailyYield(s, DEC_A, DEC_B)!;
      expect(r.intervals).to.equal(2);
      expect(r.gapIntervals).to.equal(1);
      expect(r.coveredSeconds).to.equal(1800);
      expect(r.feesQuote).to.be.closeTo(200, 1e-9);
      // window still reports full wall-clock span
      expect(r.windowSeconds).to.equal(9000);
    });

    it("snapshots without vaults yield null (never a guessed TVL)", () => {
      const L = 10n ** 6n;
      const bare = snap(900, 100, 1000n * Q64, 0n, L); // no vaultA/B
      // Both intervals touch the vaultless snapshot → nothing usable.
      const s = [vaulted(0, 100, 0n, 0n, L), bare, vaulted(1800, 100, 2000n * Q64, 0n, L)];
      expect(measurePoolDailyYield(s, DEC_A, DEC_B)).to.equal(null);
    });

    it("a wrapped/reset accumulator is rejected as implausible, never included", () => {
      const L = 10n ** 6n;
      const s = [
        // Backwards accumulator (pool re-deploy) → wrap-delta ≈ 2^128 → rejected.
        vaulted(0, 100, 5000n * Q64, 0n, L),
        vaulted(900, 100, 10n * Q64, 0n, L),
        // Sane again: Δ = 1000/L native → 1 SOL = $100 fees → kept.
        vaulted(1800, 100, 1010n * Q64, 0n, L),
      ];
      const r = measurePoolDailyYield(s, DEC_A, DEC_B)!;
      expect(r.implausibleIntervals).to.equal(1);
      expect(r.intervals).to.equal(1);
      expect(r.feesQuote).to.be.closeTo(100, 1e-9);
    });

    it("returns null when fewer than two snapshots exist", () => {
      expect(measurePoolDailyYield([vaulted(0, 100, 0n, 0n)], DEC_A, DEC_B)).to.equal(null);
      expect(measurePoolDailyYield([], DEC_A, DEC_B)).to.equal(null);
    });
  });

  it("store: append/read/latest roundtrip, time-filtered and sorted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-snaps-"));
    try {
      const store = new FilePoolSnapshotStore(dir);
      await store.append("POOL1", snap(1000, 150, 1n * Q64, 1n * Q64));
      await store.append("POOL1", snap(1900, 151, 2n * Q64, 2n * Q64));
      await store.append("POOL1", snap(100, 149, 0n, 0n)); // out-of-order append
      const window = await store.read("POOL1", 500, 2000);
      expect(window.map((s) => s.t)).to.deep.equal([1000, 1900]);
      expect((await store.latest("POOL1"))!.t).to.equal(1900);
      expect(await store.latest("NOPE")).to.equal(null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
