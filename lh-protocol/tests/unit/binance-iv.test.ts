/**
 * binance-iv.test.ts — unit tests for the IV adapter's PURE logic.
 * The network fetch path (`fetchSolAtmImpliedVol`) is validated live in
 * the live-orca run (no HTTP in unit tests).
 */

import { expect } from "chai";
import { computeIvRvRatio } from "../../protocol-src/market-data/binance-iv-adapter";

describe("computeIvRvRatio", () => {
  it("returns measured ratio when inputs are valid", () => {
    const r = computeIvRvRatio(0.55, 0.70);
    expect(r.source).to.equal("measured");
    expect(r.ratio).to.be.closeTo(0.55 / 0.70, 1e-12);
  });

  it("passes through ratio > 1 (stress regime where IV > RV)", () => {
    const r = computeIvRvRatio(0.90, 0.70);
    expect(r.source).to.equal("measured");
    expect(r.ratio).to.be.closeTo(0.90 / 0.70, 1e-12);
    expect(r.ratio).to.be.greaterThan(1);
  });

  it("passes through ratio < 1 (calm regime where IV < RV) — floor will bind downstream", () => {
    const r = computeIvRvRatio(0.50, 0.70);
    expect(r.source).to.equal("measured");
    expect(r.ratio).to.be.closeTo(0.50 / 0.70, 1e-12);
    expect(r.ratio).to.be.lessThan(1);
  });

  it("falls back when IV is null (network failure, no SOL options)", () => {
    const r = computeIvRvRatio(null, 0.70, 1.05);
    expect(r.source).to.equal("fallback");
    expect(r.ratio).to.equal(1.05);
  });

  it("falls back when IV is non-finite or non-positive", () => {
    expect(computeIvRvRatio(NaN, 0.70).source).to.equal("fallback");
    expect(computeIvRvRatio(0, 0.70).source).to.equal("fallback");
    expect(computeIvRvRatio(-0.1, 0.70).source).to.equal("fallback");
  });

  it("falls back when realized vol is degenerate", () => {
    expect(computeIvRvRatio(0.6, 0).source).to.equal("fallback");
    expect(computeIvRvRatio(0.6, NaN).source).to.equal("fallback");
  });

  it("default fallback is 1.0 so the markupFloor dominates, not stale data", () => {
    const r = computeIvRvRatio(null, 0.70);
    expect(r.ratio).to.equal(1.0);
  });
});
