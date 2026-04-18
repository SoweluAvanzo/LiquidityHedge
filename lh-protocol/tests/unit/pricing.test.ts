/**
 * Unit tests for the pricing engine (computeQuote).
 *
 * Tests the on-chain heuristic formula with known inputs and expected outputs.
 * Verifies edge cases, monotonicity properties, and floor/ceiling clamping.
 *
 * Run: npx ts-mocha tests/unit/pricing.test.ts
 */

import { expect } from "chai";
import { computeQuote } from "../../protocol/offchain-emulator/operations/pricing";
import { PoolState, TemplateConfig, RegimeSnapshot } from "../../protocol/types";

// ─── Test Fixtures ──────────────────────────────────────────────────

function makePool(overrides?: Partial<PoolState>): PoolState {
  return {
    admin: "admin",
    usdcMint: "usdc",
    usdcVault: "vault",
    reservesUsdc: 100_000_000,   // $100
    activeCapUsdc: 10_000_000,   // $10 active
    totalShares: 100_000_000,
    uMaxBps: 8_000,              // 80%
    ...overrides,
  };
}

function makeTemplate(overrides?: Partial<TemplateConfig>): TemplateConfig {
  return {
    templateId: 1,
    tenorSeconds: 7 * 86_400,     // 7 days
    widthBps: 1_000,              // ±10%
    severityPpm: 420_000,         // calibrated for ±10%
    premiumFloorUsdc: 1_000,      // $0.001
    premiumCeilingUsdc: 1_000_000_000, // $1000
    active: true,
    ...overrides,
  };
}

function makeRegime(overrides?: Partial<RegimeSnapshot>): RegimeSnapshot {
  return {
    sigmaPpm: 650_000,            // 65%
    sigmaMaPpm: 600_000,
    stressFlag: false,
    carryBpsPerDay: 10,
    updatedTs: Math.floor(Date.now() / 1000),
    signer: "risk-service",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Pricing Engine: computeQuote", () => {
  describe("Basic computation", () => {
    it("produces a positive premium for standard inputs", () => {
      const quote = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime()); // $1 cap
      expect(quote.premiumUsdc).to.be.greaterThan(0);
      expect(quote.expectedPayoutUsdc).to.be.greaterThan(0);
      expect(quote.capUsdc).to.equal(1_000_000);
    });

    it("premium >= expected payout (risk loading)", () => {
      const quote = computeQuote(5_000_000, makeTemplate(), makePool(), makeRegime());
      expect(quote.premiumUsdc).to.be.at.least(quote.expectedPayoutUsdc);
    });

    it("returns all breakdown components", () => {
      const quote = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime());
      expect(quote.expectedPayoutUsdc).to.be.a("number");
      expect(quote.capitalChargeUsdc).to.be.a("number");
      expect(quote.adverseSelectionUsdc).to.be.a("number");
      expect(quote.replicationCostUsdc).to.be.a("number");
    });

    it("premium = sum of components (before clamping)", () => {
      const quote = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime());
      const sum = quote.expectedPayoutUsdc + quote.capitalChargeUsdc +
                  quote.adverseSelectionUsdc + quote.replicationCostUsdc;
      // Premium may be clamped, so it should be >= floor and <= ceiling
      // If not clamped, should equal sum
      if (sum >= 1_000 && sum <= 1_000_000_000) {
        expect(quote.premiumUsdc).to.equal(sum);
      }
    });
  });

  describe("Monotonicity properties", () => {
    it("premium increases with volatility", () => {
      const low = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ sigmaPpm: 200_000 }));
      const mid = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ sigmaPpm: 650_000 }));
      const high = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ sigmaPpm: 1_200_000 }));
      expect(mid.premiumUsdc).to.be.greaterThan(low.premiumUsdc);
      expect(high.premiumUsdc).to.be.greaterThan(mid.premiumUsdc);
    });

    it("premium increases with cap", () => {
      const small = computeQuote(500_000, makeTemplate(), makePool(), makeRegime());
      const large = computeQuote(5_000_000, makeTemplate(), makePool(), makeRegime());
      expect(large.premiumUsdc).to.be.greaterThan(small.premiumUsdc);
    });

    it("premium increases with utilization", () => {
      const lowUtil = computeQuote(1_000_000, makeTemplate(),
        makePool({ activeCapUsdc: 1_000_000 }), makeRegime());
      const highUtil = computeQuote(1_000_000, makeTemplate(),
        makePool({ activeCapUsdc: 50_000_000 }), makeRegime());
      expect(highUtil.premiumUsdc).to.be.greaterThan(lowUtil.premiumUsdc);
    });

    it("premium increases with tenor", () => {
      const short = computeQuote(1_000_000, makeTemplate({ tenorSeconds: 3600 }), makePool(), makeRegime());
      const long = computeQuote(1_000_000, makeTemplate({ tenorSeconds: 30 * 86400 }), makePool(), makeRegime());
      expect(long.premiumUsdc).to.be.greaterThan(short.premiumUsdc);
    });

    it("premium decreases with wider width (lower p_hit)", () => {
      const narrow = computeQuote(1_000_000, makeTemplate({ widthBps: 500 }), makePool(), makeRegime());
      const wide = computeQuote(1_000_000, makeTemplate({ widthBps: 2000 }), makePool(), makeRegime());
      expect(narrow.premiumUsdc).to.be.greaterThan(wide.premiumUsdc);
    });
  });

  describe("Stress flag", () => {
    it("adverse selection = 0 when no stress", () => {
      const quote = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ stressFlag: false }));
      expect(quote.adverseSelectionUsdc).to.equal(0);
    });

    it("adverse selection = cap/10 when stressed", () => {
      const cap = 10_000_000; // $10
      const quote = computeQuote(cap, makeTemplate(), makePool(), makeRegime({ stressFlag: true }));
      expect(quote.adverseSelectionUsdc).to.equal(Math.floor(cap / 10));
    });

    it("stress adds to premium", () => {
      const noStress = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ stressFlag: false }));
      const stress = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ stressFlag: true }));
      expect(stress.premiumUsdc).to.be.greaterThan(noStress.premiumUsdc);
    });
  });

  describe("Floor and ceiling clamping", () => {
    it("premium >= floor", () => {
      const floor = 500_000; // $0.50
      const quote = computeQuote(1_000, makeTemplate({ premiumFloorUsdc: floor, severityPpm: 1 }),
        makePool(), makeRegime({ sigmaPpm: 1_000 }));
      expect(quote.premiumUsdc).to.be.at.least(floor);
    });

    it("premium <= ceiling", () => {
      const ceiling = 100_000; // $0.10
      const quote = computeQuote(1_000_000, makeTemplate({ premiumCeilingUsdc: ceiling }),
        makePool({ reservesUsdc: 1_000_000_000 }), makeRegime({ sigmaPpm: 2_000_000 }));
      expect(quote.premiumUsdc).to.be.at.most(ceiling);
    });
  });

  describe("Utilization constraint", () => {
    it("rejects when utilization exceeds u_max", () => {
      const pool = makePool({ reservesUsdc: 10_000_000, activeCapUsdc: 8_000_000, uMaxBps: 8_000 });
      // Adding $3 cap would push utilization above 80%
      expect(() => computeQuote(3_000_000, makeTemplate(), pool, makeRegime()))
        .to.throw(/InsufficientHeadroom|headroom/i);
    });

    it("accepts when utilization is within u_max", () => {
      const pool = makePool({ reservesUsdc: 100_000_000, activeCapUsdc: 10_000_000, uMaxBps: 8_000 });
      expect(() => computeQuote(1_000_000, makeTemplate(), pool, makeRegime()))
        .to.not.throw();
    });
  });

  describe("Edge cases", () => {
    it("handles minimum tenor (60 seconds)", () => {
      const quote = computeQuote(1_000_000, makeTemplate({ tenorSeconds: 60 }), makePool(), makeRegime());
      expect(quote.premiumUsdc).to.be.greaterThan(0);
    });

    it("handles very high sigma (500%)", () => {
      const quote = computeQuote(1_000_000, makeTemplate(), makePool(), makeRegime({ sigmaPpm: 5_000_000 }));
      expect(quote.premiumUsdc).to.be.greaterThan(0);
      expect(Number.isFinite(quote.premiumUsdc)).to.be.true;
    });

    it("handles very small cap ($0.001)", () => {
      const quote = computeQuote(1_000, makeTemplate(), makePool(), makeRegime());
      expect(quote.premiumUsdc).to.be.at.least(0);
    });

    it("p_hit caps at 1.0 (PPM) for extreme sigma", () => {
      const extreme = computeQuote(1_000_000,
        makeTemplate({ widthBps: 100 }), // very narrow
        makePool(), makeRegime({ sigmaPpm: 5_000_000 })); // extreme vol
      // p_hit should cap at PPM, so E[Payout] = cap * 1.0 * severity / PPM
      const expectedMax = Math.floor(1_000_000 * 420_000 / 1_000_000);
      expect(extreme.expectedPayoutUsdc).to.be.at.most(expectedMax + 1);
    });
  });

  describe("Calibrated templates (optimized parameters)", () => {
    it("±5% template at σ=65% produces ~1.20× fair value", () => {
      // Fair value at σ=65%, ±5%, 7d, barrier=90%: ~$253 for $880 cap
      // Heuristic with severity=345,000 should produce ~$304
      const quote = computeQuote(880_000_000, // $880 cap
        makeTemplate({ widthBps: 500, severityPpm: 345_000 }),
        makePool({ reservesUsdc: 10_000_000_000, activeCapUsdc: 0, uMaxBps: 5000 }),
        makeRegime({ sigmaPpm: 650_000, carryBpsPerDay: 10 })
      );
      // Premium should be around $280-$330 range (1.10-1.30× fair value)
      const premiumUsd = quote.premiumUsdc / 1e6;
      expect(premiumUsd).to.be.within(250, 350);
    });

    it("±10% template at σ=65% produces ~1.20× fair value", () => {
      const quote = computeQuote(745_000_000, // $745 cap
        makeTemplate({ widthBps: 1_000, severityPpm: 420_000 }),
        makePool({ reservesUsdc: 10_000_000_000, activeCapUsdc: 0, uMaxBps: 5000 }),
        makeRegime({ sigmaPpm: 650_000, carryBpsPerDay: 10 })
      );
      const premiumUsd = quote.premiumUsdc / 1e6;
      expect(premiumUsd).to.be.within(210, 350);
    });

    it("±15% template at σ=65% produces ~1.20× fair value", () => {
      const quote = computeQuote(645_000_000, // $645 cap
        makeTemplate({ widthBps: 1_500, severityPpm: 640_000 }),
        makePool({ reservesUsdc: 10_000_000_000, activeCapUsdc: 0, uMaxBps: 5000 }),
        makeRegime({ sigmaPpm: 650_000, carryBpsPerDay: 10 })
      );
      const premiumUsd = quote.premiumUsdc / 1e6;
      expect(premiumUsd).to.be.within(180, 310);
    });
  });
});
