/**
 * Φ pinned to known values.
 *
 * The previous implementation returned Φ(0) = 0.601 and shipped for
 * months because no test asserted a single known value — the callers'
 * tests only checked monotonicity and [0,1] bounds, which a wrong CDF
 * satisfies perfectly. These are the assertions that would have caught it.
 */
import { expect } from "chai";
import { normalCdf, erf } from "../../src/utils/normal";

describe("@lh/core standard normal CDF", () => {
  it("is exactly 0.5 at zero", () => {
    expect(normalCdf(0)).to.equal(0.5);
  });

  it("matches published values of Φ", () => {
    const KNOWN: Array<[number, number]> = [
      [-3, 0.001349898], [-2, 0.022750132], [-1.959963985, 0.025],
      [-1, 0.158655254], [-0.5, 0.308537539], [0, 0.5],
      [0.5, 0.691462461], [1, 0.841344746], [1.644853627, 0.95],
      [1.959963985, 0.975], [2, 0.977249868], [3, 0.998650102],
    ];
    for (const [x, expected] of KNOWN) {
      expect(normalCdf(x), `Phi(${x})`).to.be.closeTo(expected, 1.5e-7);
    }
  });

  it("is symmetric: Φ(-x) = 1 - Φ(x)", () => {
    for (const x of [0.1, 0.75, 1.5, 2.5, 4]) {
      expect(normalCdf(-x)).to.be.closeTo(1 - normalCdf(x), 1e-12);
    }
  });

  it("is monotone and bounded", () => {
    let prev = -1;
    for (let x = -6; x <= 6; x += 0.25) {
      const v = normalCdf(x);
      expect(v).to.be.at.least(0);
      expect(v).to.be.at.most(1);
      expect(v).to.be.at.least(prev);
      prev = v;
    }
  });

  it("erf matches published values", () => {
    expect(erf(0)).to.equal(0);
    expect(erf(0.5)).to.be.closeTo(0.520499878, 1.5e-7);
    expect(erf(1)).to.be.closeTo(0.842700793, 1.5e-7);
    expect(erf(-1)).to.be.closeTo(-0.842700793, 1.5e-7);
    expect(erf(2)).to.be.closeTo(0.995322265, 1.5e-7);
  });
});
