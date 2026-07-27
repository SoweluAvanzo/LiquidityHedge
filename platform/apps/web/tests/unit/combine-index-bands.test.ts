import { expect } from "chai";
import { combineIndexBands } from "../../src/lib/server/viability";

/**
 * §1.7: per-source perturbations combine in quadrature, asymmetric;
 * +Infinity legs unbound the upper edge; NaN voids the band.
 */
describe("combineIndexBands (§1.7 quadrature combination)", () => {
  it("known value: two independent one-sided sources combine in quadrature", () => {
    // Source A moves the index −0.3/+0.4, source B −0.4/+0.3:
    // lo = √(0.3² + 0.4²) = 0.5, hi = √(0.4² + 0.3²) = 0.5.
    const b = combineIndexBands(1.0, [
      [0.7, 1.4],
      [0.6, 1.3],
    ])!;
    expect(b.p05).to.be.closeTo(0.5, 1e-12);
    expect(b.p95).to.be.closeTo(1.5, 1e-12);
  });

  it("uses the worst excursion per side within one source", () => {
    // Both edges of one source land below the point — lo takes the
    // worse one, hi stays 0.
    const b = combineIndexBands(1.0, [[0.8, 0.9]])!;
    expect(b.p05).to.be.closeTo(0.8, 1e-12);
    expect(b.p95).to.be.closeTo(1.0, 1e-12);
  });

  it("floors the lower edge at zero (indices are ratios)", () => {
    const b = combineIndexBands(0.1, [[0.0, 0.5]])!;
    expect(b.p05).to.equal(0);
  });

  it("a +Infinity leg (perturbation drove breakeven to zero) unbounds the upper edge", () => {
    const b = combineIndexBands(0.9, [[0.7, Number.POSITIVE_INFINITY]])!;
    expect(b.p95).to.equal(null);
    expect(b.p05).to.be.closeTo(0.7, 1e-12);
  });

  it("NaN voids the band; an unbounded point has no band", () => {
    expect(combineIndexBands(1.0, [[Number.NaN]])).to.equal(null);
    expect(combineIndexBands(null, [[0.5]])).to.equal(null);
    expect(combineIndexBands(Number.POSITIVE_INFINITY, [[0.5]])).to.equal(null);
  });

  it("empty legs (unquantified source) contribute nothing", () => {
    const b = combineIndexBands(0.5, [[], [0.4, 0.6], []])!;
    expect(b.p05).to.be.closeTo(0.4, 1e-12);
    expect(b.p95).to.be.closeTo(0.6, 1e-12);
  });
});
