import { expect } from "chai";
import {
  composeInRangeEstimate,
  MODEL_RISK_THRESHOLD,
  MIN_EMPIRICAL_WINDOWS,
} from "../../src/in-range-estimate";

const GBM = { fraction: 0.7, sigmaAnnual: 0.69 };
const EMP = { mean: 0.55, p05: 0.2, p95: 0.9, windows: 300, horizonSteps: 7 };

describe("@lh/portfolio in-range estimator composition (transparency contract)", () => {
  it("empirical leads when enough windows; GBM shown as reference; divergence computed", () => {
    const r = composeInRangeEstimate({ empirical: EMP, gbm: GBM });
    expect(r.method).to.equal("empirical");
    expect(r.fraction).to.equal(0.55);
    expect(r.band).to.deep.equal({ p05: 0.2, p95: 0.9 });
    expect(r.reference).to.deep.equal({ method: "gbm-analytic", fraction: 0.7 });
    expect(r.divergence).to.be.closeTo(0.15 / 0.7, 1e-12);
    expect(r.modelRiskFlag).to.equal((0.15 / 0.7) > MODEL_RISK_THRESHOLD);
    expect(r.description).to.match(/^Empirical: measured over 300 rolling/);
    expect(r.fallbackReason).to.equal(null);
  });

  it("agreement below threshold → no model-risk flag", () => {
    const r = composeInRangeEstimate({
      empirical: { ...EMP, mean: 0.68 },
      gbm: GBM,
    });
    expect(r.modelRiskFlag).to.equal(false);
    expect(r.divergence).to.be.closeTo(0.02 / 0.7, 1e-12);
  });

  it("no history → GBM fallback with explicit reason in the description", () => {
    const r = composeInRangeEstimate({
      empirical: null,
      gbm: GBM,
      empiricalUnavailableReason: "market-data provider key suspended",
    });
    expect(r.method).to.equal("gbm-analytic");
    expect(r.fraction).to.equal(0.7);
    expect(r.band).to.equal(null);
    expect(r.reference).to.equal(null);
    expect(r.description).to.match(/Model-based \(GBM\)/);
    expect(r.description).to.match(/key suspended/);
    expect(r.fallbackReason).to.equal("market-data provider key suspended");
  });

  it("too few windows → GBM fallback stating the window count", () => {
    const r = composeInRangeEstimate({
      empirical: { ...EMP, windows: MIN_EMPIRICAL_WINDOWS - 1 },
      gbm: GBM,
    });
    expect(r.method).to.equal("gbm-analytic");
    expect(r.fallbackReason).to.match(/only 59 historical windows/);
  });

  it("§1.5: meanCi and nEffective pass through, and the description states the effective count", () => {
    const r = composeInRangeEstimate({
      empirical: {
        ...EMP,
        meanCi: { p05: 0.48, p95: 0.62 },
        nEffective: 43,
      },
      gbm: GBM,
    });
    expect(r.meanCi).to.deep.equal({ p05: 0.48, p95: 0.62 });
    expect(r.nEffective).to.equal(43);
    // The verbatim description must not overstate the evidence: raw
    // window count and effective count travel together.
    expect(r.description).to.match(/300 rolling historical windows \(≈43 effective/);
    expect(r.description).to.match(/overlap 6 of 7 days/);
    // The outcome band is preserved unchanged alongside the new CI.
    expect(r.band).to.deep.equal({ p05: 0.2, p95: 0.9 });
  });

  it("§1.5: older callers without meanCi still compose (null fields, old description)", () => {
    const r = composeInRangeEstimate({ empirical: EMP, gbm: GBM });
    expect(r.meanCi).to.equal(null);
    expect(r.nEffective).to.equal(null);
    expect(r.description).to.match(/300 rolling historical windows —/);
  });
});
