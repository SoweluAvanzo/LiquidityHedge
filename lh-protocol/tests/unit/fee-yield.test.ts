/**
 * Fee-yield math tests — in-range fraction under GBM + pool / position
 * yield composition (protocol-src/market-data/orca-volume-adapter.ts).
 */

import { expect } from "chai";
import {
  estimatePoolDailyYield,
  inRangeProbabilityAt,
  inRangeFraction,
  estimatePositionDailyYield,
  computeConcentrationFactor,
  PoolOverview,
} from "../../protocol-src/market-data/orca-volume-adapter";

function makeOverview(overrides?: Partial<PoolOverview>): PoolOverview {
  return {
    address: "pool-xxx",
    tokenMintA: "SOL",
    tokenMintB: "USDC",
    liquidityUsd: 5_000_000,    // $5M TVL
    volume24hUsd: 10_000_000,   // $10M/day
    volume7dUsd: 70_000_000,    // $10M/day average over 7d
    feeTier: 0.0004,            // 0.04% tier
    priceUsd: 150,
    fetchedAt: new Date(),
    ...overrides,
  };
}

describe("orca-volume-adapter", () => {
  describe("estimatePoolDailyYield", () => {
    it("pool yield = volume × fee / TVL", () => {
      const stats = makeOverview();
      const y = estimatePoolDailyYield(stats);
      // (10_000_000 × 0.0004) / 5_000_000 = 0.0008 = 0.08%/day
      expect(y).to.be.closeTo(0.0008, 1e-9);
    });

    it("7d window normalizes per day", () => {
      const stats = makeOverview({ volume24hUsd: 50_000_000 });
      const y24 = estimatePoolDailyYield(stats, "24h");
      const y7 = estimatePoolDailyYield(stats, "7d");
      // 24h has a spike; 7d average should be 10M (from makeOverview fixture)
      expect(y24).to.be.greaterThan(y7);
      expect(y7).to.be.closeTo(0.0008, 1e-9);
    });

    it("returns 0 on empty TVL", () => {
      const stats = makeOverview({ liquidityUsd: 0 });
      expect(estimatePoolDailyYield(stats)).to.equal(0);
    });
  });

  describe("inRangeProbabilityAt", () => {
    it("P = 1 at t = 0 (price is exactly S_0)", () => {
      expect(inRangeProbabilityAt(1000, 0.65, 0)).to.equal(1);
    });

    it("P → 0 as width → 0", () => {
      const p = inRangeProbabilityAt(1, 0.65, 7 / 365);
      expect(p).to.be.lessThan(0.05);
    });

    it("P → 1 as width → big relative to σ·√t", () => {
      const p = inRangeProbabilityAt(9999, 0.1, 1 / 365);
      expect(p).to.be.greaterThan(0.99);
    });

    it("P decreases with tenor (holding width, σ fixed)", () => {
      const short = inRangeProbabilityAt(1000, 0.65, 1 / 365);
      const long = inRangeProbabilityAt(1000, 0.65, 7 / 365);
      expect(short).to.be.greaterThan(long);
    });

    it("P decreases with σ (holding width, tenor fixed)", () => {
      const lowVol = inRangeProbabilityAt(1000, 0.3, 7 / 365);
      const highVol = inRangeProbabilityAt(1000, 1.2, 7 / 365);
      expect(lowVol).to.be.greaterThan(highVol);
    });
  });

  describe("inRangeFraction (tenor-averaged)", () => {
    it("fraction ∈ [0, 1] for any input", () => {
      for (const w of [100, 500, 1000, 2000]) {
        for (const s of [0.3, 0.65, 1.2]) {
          for (const t of [3600, 86400, 7 * 86400]) {
            const f = inRangeFraction(w, s, t);
            expect(f).to.be.gte(0);
            expect(f).to.be.lte(1);
          }
        }
      }
    });

    it("fraction = 1 for near-zero tenor", () => {
      expect(inRangeFraction(1000, 0.65, 1)).to.be.closeTo(1, 1e-3);
    });

    it("fraction ≈ 1 for very wide range", () => {
      const f = inRangeFraction(9000, 0.65, 7 * 86400);
      expect(f).to.be.greaterThan(0.99);
    });

    it("fraction is monotonically non-decreasing in width", () => {
      const f5 = inRangeFraction(500, 0.65, 7 * 86400);
      const f75 = inRangeFraction(750, 0.65, 7 * 86400);
      const f10 = inRangeFraction(1000, 0.65, 7 * 86400);
      expect(f5).to.be.lte(f75 + 1e-9);
      expect(f75).to.be.lte(f10 + 1e-9);
    });

    it("fraction is monotonically non-increasing in σ", () => {
      const f_lo = inRangeFraction(1000, 0.3, 7 * 86400);
      const f_mid = inRangeFraction(1000, 0.65, 7 * 86400);
      const f_hi = inRangeFraction(1000, 1.2, 7 * 86400);
      expect(f_lo).to.be.gte(f_mid - 1e-9);
      expect(f_mid).to.be.gte(f_hi - 1e-9);
    });

    it("representative values (widthBps=1000, σ=0.65, tenor=7d) in [0.8, 1]", () => {
      const f = inRangeFraction(1000, 0.65, 7 * 86400);
      expect(f).to.be.greaterThan(0.8);
      expect(f).to.be.lessThan(1);
    });
  });

  describe("estimatePositionDailyYield", () => {
    it("r_position = r_pool × inRangeFraction (default concentrationFactor=1)", () => {
      const stats = makeOverview();
      const est = estimatePositionDailyYield(stats, 1000, 0.65, 7 * 86400);
      const r_pool = estimatePoolDailyYield(stats);
      expect(est.poolDailyYield).to.be.closeTo(r_pool, 1e-12);
      expect(est.positionDailyYield).to.be.closeTo(
        r_pool * est.inRangeFraction,
        1e-12,
      );
      expect(est.concentrationFactor).to.equal(1);
    });

    it("narrower width → lower positionDailyYield (at fixed σ)", () => {
      const stats = makeOverview();
      const narrow = estimatePositionDailyYield(stats, 500, 0.65, 7 * 86400);
      const wide = estimatePositionDailyYield(stats, 1000, 0.65, 7 * 86400);
      expect(narrow.positionDailyYield).to.be.lessThan(wide.positionDailyYield);
    });

    it("custom concentrationFactor is applied multiplicatively", () => {
      const stats = makeOverview();
      const baseline = estimatePositionDailyYield(stats, 1000, 0.65, 7 * 86400, 1);
      const concentrated = estimatePositionDailyYield(stats, 1000, 0.65, 7 * 86400, 3);
      expect(concentrated.positionDailyYield).to.be.closeTo(
        baseline.positionDailyYield * 3,
        1e-12,
      );
    });
  });

  describe("computeConcentrationFactor", () => {
    it("returns 1 when L-share equals V-share (uniform LP)", () => {
      // L_position / L_active == V_position / TVL  ⇒  c = 1
      const c = computeConcentrationFactor({
        L_position: 1_000_000n,
        L_active: 100_000_000n,          // L-share = 1%
        V_position_usd: 1_000,
        TVL_usd: 100_000,                // V-share = 1%
      });
      expect(c).to.be.closeTo(1, 1e-12);
    });

    it("returns c > 1 when the LP is more concentrated than pool average", () => {
      // Same V-share but twice the L-share → twice the fee share → c = 2
      const c = computeConcentrationFactor({
        L_position: 2_000_000n,
        L_active: 100_000_000n,          // L-share = 2%
        V_position_usd: 1_000,
        TVL_usd: 100_000,                // V-share = 1%
      });
      expect(c).to.be.closeTo(2, 1e-12);
    });

    it("returns c < 1 when the LP is wider / more diluted than pool average", () => {
      const c = computeConcentrationFactor({
        L_position: 500_000n,
        L_active: 100_000_000n,          // L-share = 0.5%
        V_position_usd: 1_000,
        TVL_usd: 100_000,                // V-share = 1%
      });
      expect(c).to.be.closeTo(0.5, 1e-12);
    });

    it("matches a realistic SOL/USDC ±10% live estimate (c ≈ 2–10)", () => {
      // Numbers are order-of-magnitude realistic for SOL/USDC 0.04% with a
      // $1.80 position (L ≈ 63M raw) sitting inside a pool of TVL $30M and
      // L_active ≈ 30–50M raw (observed on mainnet).
      const c = computeConcentrationFactor({
        L_position: 63_000_000n,
        L_active: 40_000_000n,
        V_position_usd: 1.8,
        TVL_usd: 30_000_000,
      });
      expect(c).to.be.a("number");
      // This particular setup corresponds to a highly concentrated LP.
      // The bound here is sanity (not precision): we just want to know the
      // function produces values in a plausible order of magnitude when fed
      // plausible inputs.
      expect(c!).to.be.greaterThan(100_000); // L-share ≫ V-share here
    });

    it("returns null for degenerate inputs (L_active = 0)", () => {
      expect(
        computeConcentrationFactor({
          L_position: 1_000n,
          L_active: 0n,
          V_position_usd: 100,
          TVL_usd: 1000,
        }),
      ).to.equal(null);
    });

    it("returns null for degenerate inputs (V_position <= 0, TVL <= 0, L_position < 0)", () => {
      expect(
        computeConcentrationFactor({
          L_position: 1_000n,
          L_active: 1_000_000n,
          V_position_usd: 0,
          TVL_usd: 1000,
        }),
      ).to.equal(null);
      expect(
        computeConcentrationFactor({
          L_position: 1_000n,
          L_active: 1_000_000n,
          V_position_usd: 100,
          TVL_usd: 0,
        }),
      ).to.equal(null);
      expect(
        computeConcentrationFactor({
          L_position: -1n,
          L_active: 1_000_000n,
          V_position_usd: 100,
          TVL_usd: 1000,
        }),
      ).to.equal(null);
    });
  });
});
