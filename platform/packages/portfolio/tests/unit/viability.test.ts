import { expect } from "chai";
import { computeViability, computeTwoSidedViability } from "../../src/viability";

describe("@lh/portfolio viability index (FR-M8)", () => {
  const BASE = {
    fairValueUsd: 100,
    effectiveMarkup: 1.08,
    premiumFloorUsd: 1.5,
    feeSplitRate: 0.1,
    positionValueUsd: 11_000,
    tenorDays: 7,
    measuredDailyYield: 0.002,
  };

  it("formula branch: breakeven fees = FV·(m_vol − 1); the defining identity holds", () => {
    const r = computeViability(BASE);
    expect(r.bound).to.equal("formula");
    expect(r.breakevenFeesUsd).to.be.closeTo(100 * 0.08, 1e-12);
    // Defining identity at breakeven: F·(1−y) + FV = Premium(F)
    const premiumAtF =
      BASE.fairValueUsd * BASE.effectiveMarkup -
      BASE.feeSplitRate * r.breakevenFeesUsd;
    expect(r.breakevenFeesUsd * (1 - BASE.feeSplitRate) + BASE.fairValueUsd).to.be.closeTo(
      premiumAtF,
      1e-9,
    );
  });

  it("floor branch: tiny FV → breakeven = (P_floor − FV)/(1−y)", () => {
    const r = computeViability({ ...BASE, fairValueUsd: 0.5, premiumFloorUsd: 1.5 });
    expect(r.bound).to.equal("floor");
    expect(r.breakevenFeesUsd).to.be.closeTo((1.5 - 0.5) / 0.9, 1e-12);
  });

  it("floor branch clamps at zero when FV ≥ P_floor would make it negative", () => {
    const r = computeViability({
      ...BASE,
      fairValueUsd: 2,
      effectiveMarkup: 1.0, // formula breakeven = 0 → premium 2 ≥ floor 1.5 → formula branch, F*=0
    });
    expect(r.breakevenFeesUsd).to.equal(0);
    expect(r.viabilityIndex).to.equal(Infinity);
  });

  it("VI = 1 exactly when measured yield equals breakeven yield", () => {
    const r0 = computeViability(BASE);
    const r1 = computeViability({
      ...BASE,
      measuredDailyYield: r0.breakevenDailyYield,
    });
    expect(r1.viabilityIndex).to.be.closeTo(1, 1e-12);
  });

  it("VI scales linearly with measured yield and decreases with markup", () => {
    const r1 = computeViability({ ...BASE, measuredDailyYield: 0.001 });
    const r2 = computeViability({ ...BASE, measuredDailyYield: 0.002 });
    expect(r2.viabilityIndex / r1.viabilityIndex).to.be.closeTo(2, 1e-9);
    const hi = computeViability({ ...BASE, effectiveMarkup: 1.2 });
    expect(hi.viabilityIndex).to.be.lessThan(r2.viabilityIndex);
  });

  it("rejects invalid inputs loudly", () => {
    expect(() => computeViability({ ...BASE, positionValueUsd: 0 })).to.throw();
    expect(() => computeViability({ ...BASE, feeSplitRate: 1 })).to.throw();
  });
});

describe("two-sided viability (paper §2.4.3–2.4.4)", () => {
  const base = {
    expectedValueChangeUsd: -50, // divergence loss over the tenor
    premiumUsd: 20,
    protocolFeeRate: 0.015,
    positionValueUsd: 10_000,
    tenorDays: 7,
    measuredDailyYield: 0.001,
  };

  it("r_u is exactly the yield that offsets divergence loss", () => {
    const r = computeTwoSidedViability(base);
    // -ΔV / (V·T) = 50 / 70000
    expect(r.unhedgedBreakevenDailyYield).to.be.closeTo(50 / 70_000, 1e-12);
  });

  it("Corollary 2.1: r* − r_u = φP/(V·T)", () => {
    const r = computeTwoSidedViability(base);
    expect(r.breakevenDailyYield - r.unhedgedBreakevenDailyYield).to.be.closeTo(
      (0.015 * 20) / 70_000,
      1e-12,
    );
    expect(r.protocolFeeWedgeDailyYield).to.be.closeTo((0.015 * 20) / 70_000, 1e-12);
  });

  it("φ = 0 collapses r* onto the unhedged breakeven (Corollary 2.1)", () => {
    const r = computeTwoSidedViability({ ...base, protocolFeeRate: 0 });
    expect(r.breakevenDailyYield).to.equal(r.unhedgedBreakevenDailyYield);
  });

  it("the wedge IS φP/(V·T) — an identity, not a magnitude", () => {
    // The paper's "< 0.65 bps/day" holds at its §8.8 reference position
    // (V ~ $12k). The wedge is φP/(V·T) with P >= P_floor, so it grows
    // without bound as V shrinks — asserting the magnitude on one fixture
    // would pass while the claim silently stopped being true.
    for (const V of [1, 10, 1_000, 11_000, 1_000_000]) {
      const r = computeTwoSidedViability({ ...base, positionValueUsd: V });
      expect(r.protocolFeeWedgeDailyYield).to.be.closeTo(
        (base.protocolFeeRate * base.premiumUsd) / (V * base.tenorDays),
        1e-15,
      );
    }
    // …and it really does exceed 0.65 bps/day on a small position, which
    // is why the bound is reference-conditional rather than universal.
    const tiny = computeTwoSidedViability({ ...base, positionValueUsd: 1 });
    expect(tiny.protocolFeeWedgeDailyYield * 10_000).to.be.greaterThan(0.65);
  });

  it("includes divergence loss, so it is far stricter than the markup-drag index", () => {
    // The whole reason both indices exist: this one counts ΔV.
    const twoSided = computeTwoSidedViability(base);
    const markupDrag = computeViability({
      fairValueUsd: 15,
      effectiveMarkup: 1.05,
      premiumFloorUsd: 0.05,
      feeSplitRate: 0,
      positionValueUsd: base.positionValueUsd,
      tenorDays: base.tenorDays,
      measuredDailyYield: base.measuredDailyYield,
    });
    expect(twoSided.breakevenDailyYield).to.be.greaterThan(
      markupDrag.breakevenDailyYield,
    );
    expect(twoSided.viabilityIndex).to.be.lessThan(markupDrag.viabilityIndex);
  });

  it("a position expected to GAIN value clears any positive fee income", () => {
    const r = computeTwoSidedViability({
      ...base,
      expectedValueChangeUsd: +100,
      protocolFeeRate: 0,
    });
    expect(r.breakevenDailyYield).to.be.lessThan(0);
    expect(r.viabilityIndex).to.equal(Infinity);
  });

  it("VI scales linearly with the measured yield", () => {
    const a = computeTwoSidedViability(base);
    const b = computeTwoSidedViability({ ...base, measuredDailyYield: 0.002 });
    expect(b.viabilityIndex).to.be.closeTo(a.viabilityIndex * 2, 1e-9);
  });

  it("rejects impossible inputs rather than returning a number", () => {
    expect(() => computeTwoSidedViability({ ...base, positionValueUsd: 0 })).to.throw();
    expect(() => computeTwoSidedViability({ ...base, tenorDays: 0 })).to.throw();
    expect(() => computeTwoSidedViability({ ...base, protocolFeeRate: 1 })).to.throw();
  });
});
