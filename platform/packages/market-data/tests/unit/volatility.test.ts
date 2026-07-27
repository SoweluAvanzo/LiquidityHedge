import { expect } from "chai";
import {
  computeGarmanKlassVol,
  computeRealizedVol,
  computeNonOverlappingTenorVol,
  varianceRatio,
} from "../../src/volatility";
import { Candle } from "../../src/types";
import { mulberry32 } from "../../src/bootstrap";

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

  describe("tenor-scale dispersion (D5 arbitration)", () => {
    it("known value: alternating ±r daily returns → weekly variance collapses (mean reversion)", () => {
      // closes alternate 100, 100·e^r, 100, … : every 1-day return is ±r
      // but every 2-day return is exactly 0 → VR(2) ≈ 0.
      const r = 0.02;
      const closes = Array.from({ length: 365 }, (_, i) =>
        i % 2 === 0 ? 100 : 100 * Math.exp(r),
      );
      const vr = varianceRatio(closes, 2)!;
      expect(vr.ratio).to.be.lessThan(0.01);
      const weekly = computeNonOverlappingTenorVol(closes, 2)!;
      expect(weekly.sigmaAnnual).to.be.lessThan(0.01);
    });

    it("known value: constant drift-free ±r i.i.d.-like series → VR ≈ 1", () => {
      // Deterministic pseudo-random walk: signs from the seeded PRNG (a
      // sine-grid pattern has hidden periodicity near lag 7 and fails).
      const rng = mulberry32(42);
      let p = 100;
      const closes = [p];
      for (let i = 0; i < 364; i++) {
        const sign = rng() > 0.5 ? 1 : -1;
        p = p * Math.exp(sign * 0.02);
        closes.push(p);
      }
      const vr = varianceRatio(closes, 7)!;
      expect(vr.ratio).to.be.greaterThan(0.5);
      expect(vr.ratio).to.be.lessThan(2.0);
    });

    it("annualisation: exact for a constant per-step return magnitude", () => {
      // 7-day non-overlapping returns all equal ±R with zero mean → the
      // sample variance is R², annualized by 365/7.
      const R = 0.05;
      const closes: number[] = [100];
      for (let i = 0; i < 52; i++) {
        const sign = i % 2 === 0 ? 1 : -1;
        // one 7-step block per flat segment: 6 flat days then the jump
        for (let d = 0; d < 6; d++) closes.push(closes[closes.length - 1]);
        closes.push(closes[closes.length - 1] * Math.exp(sign * R));
      }
      const tv = computeNonOverlappingTenorVol(closes, 7)!;
      // ±R alternating with equal counts → mean 0, sample var = R²·n/(n−1)
      const expected = Math.sqrt((R * R * tv.n) / (tv.n - 1) * (365 / 7));
      expect(tv.sigmaAnnual).to.be.closeTo(expected, 1e-12);
      expect(tv.band.p05).to.be.lessThan(tv.sigmaAnnual);
      expect(tv.band.p95).to.be.greaterThan(tv.sigmaAnnual);
    });

    it("refuses thin histories", () => {
      const closes = Array.from({ length: 100 }, (_, i) => 100 + i);
      expect(computeNonOverlappingTenorVol(closes, 7)).to.equal(null); // 14 < 30 returns
    });
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
