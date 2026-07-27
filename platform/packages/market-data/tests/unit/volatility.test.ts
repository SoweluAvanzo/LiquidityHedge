import { expect } from "chai";
import { computeGarmanKlassVol, computeRealizedVol } from "../../src/volatility";
import { Candle } from "../../src/types";

/** Bar with O=C at price p, range p·e^{±k/2} (symmetric, no close move). */
function rangeBar(t: number, p: number, k: number): Candle {
  return {
    t,
    o: p,
    c: p,
    h: p * Math.exp(k / 2),
    l: p * Math.exp(-k / 2),
    v: 1,
  };
}

describe("@lh/market-data Garman–Klass volatility (§1.4)", () => {
  it("known value: O=C bars with constant H/L ratio", () => {
    // With O=C the close-open term vanishes: σ²_day = 0.5·ln(H/L)² = 0.5k².
    const k = 0.04; // ln(H/L) per day
    const candles = Array.from({ length: 40 }, (_, i) => rangeBar(i * 86_400, 100, k));
    const r = computeGarmanKlassVol(candles, "1D")!;
    const expected = Math.sqrt(0.5 * k * k * 365);
    expect(r.sigma).to.be.closeTo(expected, 1e-12);
    expect(r.method).to.equal("garman-klass");
    expect(r.nDays).to.equal(40);
  });

  it("efficiency claim is directionally real: GK band tighter than CC's 1/√(2n)", () => {
    // Alternating range widths — a series with genuine variance in the
    // contributions, so the bootstrap band is non-degenerate.
    const candles = Array.from({ length: 60 }, (_, i) =>
      rangeBar(i * 86_400, 100, i % 2 === 0 ? 0.03 : 0.05),
    );
    const r = computeGarmanKlassVol(candles, "1D")!;
    const ccRelHalfWidth = 1.645 / Math.sqrt(2 * 60); // ~10.6%
    const gkRelHalfWidth =
      (r.band.p95 - r.band.p05) / 2 / r.sigma;
    expect(gkRelHalfWidth).to.be.lessThan(ccRelHalfWidth);
    expect(r.band.p05).to.be.lessThan(r.sigma);
    expect(r.band.p95).to.be.greaterThan(r.sigma);
  });

  it("bootstrap band is deterministic (seeded) — regression harness contract", () => {
    const candles = Array.from({ length: 45 }, (_, i) =>
      rangeBar(i * 86_400, 100 + i, 0.02 + (i % 7) * 0.005),
    );
    const a = computeGarmanKlassVol(candles, "1D")!;
    const b = computeGarmanKlassVol(candles, "1D")!;
    expect(a.band.p05).to.equal(b.band.p05);
    expect(a.band.p95).to.equal(b.band.p95);
  });

  it("refuses corrupt OHLC (close above high) rather than cleaning it", () => {
    const candles = Array.from({ length: 35 }, (_, i) => rangeBar(i * 86_400, 100, 0.03));
    candles[17] = { ...candles[17], c: candles[17].h * 1.01 };
    expect(computeGarmanKlassVol(candles, "1D")).to.equal(null);
  });

  it("refuses fewer than minCandles bars", () => {
    const candles = Array.from({ length: 29 }, (_, i) => rangeBar(i * 86_400, 100, 0.03));
    expect(computeGarmanKlassVol(candles, "1D")).to.equal(null);
  });

  it("GK and CC agree in order of magnitude on a common series", () => {
    // Random-walk closes with intrabar range; both estimators should land
    // in the same ballpark (they estimate the same σ).
    let p = 100;
    const candles: Candle[] = [];
    for (let i = 0; i < 90; i++) {
      // Deterministic pseudo-returns (no ambient randomness in tests).
      const r = 0.03 * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
      const next = p * Math.exp(r);
      candles.push({
        t: i * 86_400,
        o: p,
        c: next,
        h: Math.max(p, next) * 1.01,
        l: Math.min(p, next) * 0.99,
        v: 1,
      });
      p = next;
    }
    const gk = computeGarmanKlassVol(candles, "1D")!;
    const cc = computeRealizedVol(candles, "1D")!;
    expect(gk.sigma).to.be.greaterThan(cc.sigma * 0.5);
    expect(gk.sigma).to.be.lessThan(cc.sigma * 2);
  });
});
