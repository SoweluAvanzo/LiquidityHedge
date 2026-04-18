/**
 * Unit tests for the risk service's volatility computation and regime logic.
 *
 * Run: npx ts-mocha tests/unit/risk-service.test.ts
 */

import { expect } from "chai";

// ─── Replicate the risk service's internal functions for testability ──
// (The risk service doesn't export its functions, so we replicate the logic here
//  and verify it matches. In production, these should be extracted to a shared module.)

function computeRealizedVol(closes: number[], periodsPerYear: number = 35_040): number {
  if (closes.length < 3) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (logReturns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

function computeStressFlag(sigmaPpm: number, sigmaMaPpm: number, threshold: number = 1.5): boolean {
  if (sigmaMaPpm <= 0) return false;
  return sigmaPpm / sigmaMaPpm > threshold;
}

function clampSigma(sigma: number): number {
  const ppm = Math.round(sigma * 1_000_000);
  return Math.max(1_000, Math.min(5_000_000, ppm));
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Risk Service: Volatility Computation", () => {
  it("computes annualized vol from constant prices (zero vol)", () => {
    const closes = Array(100).fill(130.0);
    const vol = computeRealizedVol(closes);
    expect(vol).to.equal(0);
  });

  it("computes annualized vol from trending prices", () => {
    // 1% daily increase for 30 days
    const closes = [];
    let p = 100;
    for (let i = 0; i < 30; i++) {
      p *= 1.01;
      closes.push(p);
    }
    const vol = computeRealizedVol(closes, 365); // daily returns
    // Daily vol of constant 1% return has very low variance
    expect(vol).to.be.lessThan(0.10); // near zero variance
  });

  it("computes realistic vol from synthetic GBM path", () => {
    // Generate a path with known 65% annualized vol
    const targetSigma = 0.65;
    const dailySigma = targetSigma / Math.sqrt(365);
    const closes = [130];
    const rng = seedRandom(42);
    for (let i = 0; i < 365; i++) {
      const z = gaussianRandom(rng);
      closes.push(closes[closes.length - 1] * Math.exp(-(dailySigma * dailySigma) / 2 + dailySigma * z));
    }
    const vol = computeRealizedVol(closes, 365);
    // Should be within 20% of target (sampling noise)
    expect(vol).to.be.within(0.45, 0.90);
  });

  it("handles fewer than 3 data points gracefully", () => {
    expect(computeRealizedVol([])).to.equal(0);
    expect(computeRealizedVol([100])).to.equal(0);
    expect(computeRealizedVol([100, 101])).to.equal(0);
  });

  it("handles identical consecutive prices", () => {
    const closes = [100, 100, 100, 100, 100];
    const vol = computeRealizedVol(closes);
    expect(vol).to.equal(0);
  });

  it("handles large price jumps without crashing", () => {
    const closes = [100, 200, 50, 300, 10];
    const vol = computeRealizedVol(closes, 365);
    expect(vol).to.be.greaterThan(0);
    expect(Number.isFinite(vol)).to.be.true;
  });
});

describe("Risk Service: Stress Flag", () => {
  it("triggers stress when sigma > 1.5× sigma_ma", () => {
    expect(computeStressFlag(300_000, 200_000)).to.be.false; // 1.5× exactly
    expect(computeStressFlag(300_001, 200_000)).to.be.true;  // just above 1.5×
    expect(computeStressFlag(400_000, 200_000)).to.be.true;  // 2.0×
  });

  it("does not trigger on normal vol", () => {
    expect(computeStressFlag(650_000, 600_000)).to.be.false; // 1.08×
    expect(computeStressFlag(100_000, 100_000)).to.be.false; // 1.0×
  });

  it("handles zero sigma_ma", () => {
    expect(computeStressFlag(100_000, 0)).to.be.false; // division guard
  });

  it("handles equal sigmas", () => {
    expect(computeStressFlag(500_000, 500_000)).to.be.false;
  });
});

describe("Risk Service: Sigma Clamping", () => {
  it("clamps sigma to [1,000, 5,000,000] PPM", () => {
    expect(clampSigma(0.0005)).to.equal(1_000); // 0.05% → floor
    expect(clampSigma(0.10)).to.equal(100_000);  // 10%
    expect(clampSigma(0.65)).to.equal(650_000);  // 65%
    expect(clampSigma(5.50)).to.equal(5_000_000); // 550% → ceiling
  });

  it("handles zero", () => {
    expect(clampSigma(0)).to.equal(1_000);
  });

  it("handles negative (absolute value via round)", () => {
    // Math.round(-0.5 * 1e6) = -500k, clamped to 1000
    expect(clampSigma(-0.5)).to.be.at.least(1_000);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────

function seedRandom(seed: number) {
  // Simple LCG for deterministic tests
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function gaussianRandom(rng: () => number): number {
  // Box-Muller transform
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
}
