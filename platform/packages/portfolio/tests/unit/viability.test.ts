import { expect } from "chai";
import { computeViability } from "../../src/viability";

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
