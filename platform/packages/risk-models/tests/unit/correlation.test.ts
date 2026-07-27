/**
 * Return-correlation reporting and its significance.
 *
 * The joint simulator applies these coefficients WITH THEIR SIGN, so a
 * sign error would silently invert a portfolio's diversification. The
 * confidence interval and p-value are what stop a coefficient estimated on
 * a short window from being read as fact.
 */

import { expect } from "chai";
import {
  AssetSeries,
  correlationReport,
  pearson,
  normalCdf,
  makeRng,
} from "../../src";

const DAY = 86_400;

/**
 * Two price series whose daily log returns have a known correlation,
 * built from a shared driver plus idiosyncratic noise.
 */
function pair(n: number, rho: number, seed: number): AssetSeries[] {
  const rng = makeRng(seed);
  const a = [100];
  const b = [50];
  const k = Math.sqrt(1 - rho * rho);
  for (let i = 0; i < n; i++) {
    // A is the driver; B loads on it by rho and takes the rest from its
    // own noise. corr(rA, rB) = rho exactly, sign included. (Giving BOTH
    // series a rho-weighted share of a common driver would instead yield
    // rho^2 — positive whatever the sign of rho.)
    const z1 = rng.gaussian();
    const z2 = rng.gaussian();
    const rA = 0.03 * z1;
    const rB = 0.03 * (rho * z1 + k * z2);
    a.push(a[a.length - 1] * Math.exp(rA));
    b.push(b[b.length - 1] * Math.exp(rB));
  }
  return [
    { assetId: "A", closes: a, stepSeconds: DAY },
    { assetId: "B", closes: b, stepSeconds: DAY },
  ];
}

describe("@lh/risk-models correlation report", () => {
  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).to.be.closeTo(0.5, 1e-6);
    expect(normalCdf(1.959963985)).to.be.closeTo(0.975, 1e-8 + 2e-7);
    expect(normalCdf(-1.959963985)).to.be.closeTo(0.025, 1e-8 + 2e-7);
    expect(normalCdf(6)).to.be.closeTo(1, 1e-6);
    expect(normalCdf(-6)).to.be.closeTo(0, 1e-6);
  });

  it("pearson is 1 / -1 / 0 on the obvious cases", () => {
    const x = [1, 2, 3, 4, 5];
    expect(pearson(x, [2, 4, 6, 8, 10])).to.be.closeTo(1, 1e-12);
    expect(pearson(x, [10, 8, 6, 4, 2])).to.be.closeTo(-1, 1e-12);
    // Flat series: undefined correlation, reported as 0 rather than NaN.
    expect(pearson(x, [7, 7, 7, 7, 7])).to.equal(0);
  });

  it("recovers a strong POSITIVE correlation, and calls it significant", () => {
    const rep = correlationReport(pair(500, 0.8, 11));
    expect(rep.assetIds).to.deep.equal(["A", "B"]);
    expect(rep.n).to.equal(500);
    expect(rep.matrix[0][0]).to.equal(1);
    expect(rep.matrix[0][1]).to.be.closeTo(rep.matrix[1][0], 1e-12);

    const [p] = rep.pairs;
    expect(p.r).to.be.closeTo(0.8, 0.08);
    expect(p.ciLow).to.be.lessThan(p.r);
    expect(p.ciHigh).to.be.greaterThan(p.r);
    expect(p.ciLow).to.be.greaterThan(0);
    expect(p.pValue).to.be.lessThan(0.001);
    expect(p.significant).to.equal(true);
  });

  it("recovers a NEGATIVE correlation with its sign intact", () => {
    // Sign matters: the joint sampler uses it, and an inverted sign would
    // turn an offsetting pair into an amplifying one.
    const rep = correlationReport(pair(500, -0.7, 23));
    const [p] = rep.pairs;
    expect(p.r).to.be.lessThan(0);
    expect(p.r).to.be.closeTo(-0.7, 0.1);
    expect(p.ciHigh).to.be.lessThan(0);
    expect(p.significant).to.equal(true);
  });

  it("does not claim significance for uncorrelated assets", () => {
    const rep = correlationReport(pair(500, 0, 7));
    const [p] = rep.pairs;
    expect(Math.abs(p.r)).to.be.lessThan(0.15);
    expect(p.ciLow).to.be.lessThan(0);
    expect(p.ciHigh).to.be.greaterThan(0);
    expect(p.significant).to.equal(false);
    expect(p.pValue).to.be.greaterThan(0.05);
  });

  it("widens the interval as the sample shrinks", () => {
    const wide = correlationReport(pair(80, 0.6, 5)).pairs[0];
    const tight = correlationReport(pair(800, 0.6, 5)).pairs[0];
    const widthOf = (p: { ciLow: number; ciHigh: number }) => p.ciHigh - p.ciLow;
    expect(widthOf(wide)).to.be.greaterThan(widthOf(tight));
  });

  it("covers every unordered pair exactly once for three assets", () => {
    const [a, b] = pair(300, 0.5, 3);
    const c = pair(300, 0.5, 99)[0];
    const rep = correlationReport([a, b, { ...c, assetId: "C" }]);
    expect(rep.pairs).to.have.length(3);
    expect(rep.pairs.map((p) => `${p.i}${p.j}`).sort()).to.deep.equal([
      "01",
      "02",
      "12",
    ]);
    expect(rep.matrix).to.have.length(3);
    for (let i = 0; i < 3; i++) {
      expect(rep.matrix[i][i]).to.equal(1);
      for (let j = 0; j < 3; j++) {
        expect(rep.matrix[i][j]).to.be.closeTo(rep.matrix[j][i], 1e-12);
      }
    }
  });

  it("aligns on the shortest series so unequal histories still report", () => {
    const [a, b] = pair(400, 0.6, 13);
    const short: AssetSeries = { ...b, closes: b.closes.slice(-120) };
    const rep = correlationReport([a, short]);
    expect(rep.n).to.equal(119); // 120 closes → 119 returns
    expect(rep.pairs[0].r).to.be.a("number");
  });

  it("states the method, including what the interval assumes", () => {
    const rep = correlationReport(pair(200, 0.5, 1));
    expect(rep.method).to.contain("Fisher");
    // The caveat must survive refactors: intervals assume independence.
    expect(rep.method.toLowerCase()).to.contain("independent observations");
  });
});
