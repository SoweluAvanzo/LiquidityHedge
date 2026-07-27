import { expect } from "chai";
import { Candle } from "../../src";
import {
  realizedInRangeFraction,
  empiricalInRangeFraction,
  empiricalInRangeFractionBounds,
} from "../../src/in-range";

function candle(l: number, h: number, c: number): Candle {
  return { t: 0, o: c, h, l, c, v: 0 };
}

describe("@lh/market-data empirical in-range estimators", () => {
  describe("realizedInRangeFraction (descriptive, fixed range)", () => {
    it("hand-computed case with OHLC overlap weighting", () => {
      const candles = [
        candle(140, 150, 145), // fully inside [130,160]
        candle(155, 175, 170), // close outside; overlap 155–160 = 5/20 = 0.25
        candle(100, 120, 110), // fully outside
        candle(128, 132, 130), // close inside; overlap 130–132 = 2/4 = 0.5
      ];
      const r = realizedInRangeFraction(candles, 130, 160);
      expect(r.fraction).to.equal(2 / 4); // closes: 145 ✓, 170 ✗, 110 ✗, 130 ✓
      expect(r.weightedFraction).to.be.closeTo((1 + 0.25 + 0 + 0.5) / 4, 1e-12);
      expect(r.observations).to.equal(4);
    });

    it("degenerate candle (h == l) falls back to the indicator", () => {
      const r = realizedInRangeFraction([candle(150, 150, 150)], 140, 160);
      expect(r.weightedFraction).to.equal(1);
    });
  });

  describe("empiricalInRangeFraction (forward-looking, relative width)", () => {
    it("constant price series → fraction 1 in every window", () => {
      const r = empiricalInRangeFraction(Array(50).fill(100), 500, 7);
      expect(r.mean).to.equal(1);
      expect(r.p05).to.equal(1);
      expect(r.windows).to.equal(43);
    });

    it("strong trend → windows exit quickly, fraction low", () => {
      const closes = Array.from({ length: 60 }, (_, i) => 100 * 1.05 ** i); // +5%/step
      const r = empiricalInRangeFraction(closes, 500, 10); // ±5% range
      // Each window exits within 1–2 steps: fraction ≈ 0.1 per window.
      expect(r.mean).to.be.lessThan(0.2);
    });

    it("hand-computed small case", () => {
      // closes: 100, 104, 106, 95 — width ±5% → window at 100: [95,105]
      // horizon 3: 104 ✓, 106 ✗, 95 ✓ → 2/3.
      const r = empiricalInRangeFraction([100, 104, 106, 95], 500, 3);
      expect(r.windows).to.equal(1);
      expect(r.mean).to.be.closeTo(2 / 3, 1e-12);
    });

    it("cross-validation: on synthetic GBM data it converges to the GBM analytic", () => {
      // Generate long daily GBM series, σ = 0.6, zero drift.
      const sigma = 0.6;
      const dt = 1 / 365;
      let state = 12345;
      const rng = () => {
        state |= 0; state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const closes = [100];
      for (let i = 0; i < 20_000; i++) {
        const u1 = Math.max(rng(), 1e-12);
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
        closes.push(closes[closes.length - 1] * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z));
      }

      const widthBps = 1000; // ±10%
      const horizon = 7; // days
      const emp = empiricalInRangeFraction(closes, widthBps, horizon);

      // GBM analytic (re-derived; mirrors core's inRangeFraction):
      // average over t of P(|log S_t/S_0 − μt| within log bounds).
      const w = widthBps / 10_000;
      const mu = -0.5 * sigma * sigma;
      const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
      function erf(x: number): number {
        const s = x < 0 ? -1 : 1;
        x = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * x);
        const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return s * y;
      }
      let analytic = 0;
      for (let d = 1; d <= horizon; d++) {
        const T = d * dt;
        const s = sigma * Math.sqrt(T);
        analytic += Phi((Math.log(1 + w) - mu * T) / s) - Phi((Math.log(1 - w) - mu * T) / s);
      }
      analytic /= horizon;

      // ~20k overlapping windows: agreement within a few percent.
      expect(emp.mean).to.be.closeTo(analytic, 0.03);
      // Distribution sanity: p05 ≤ median ≤ p95, spread exists.
      expect(emp.p05).to.be.at.most(emp.p50);
      expect(emp.p50).to.be.at.most(emp.p95);
      expect(emp.p95 - emp.p05).to.be.greaterThan(0.1);
    });

    it("rejects invalid inputs loudly", () => {
      expect(() => empiricalInRangeFraction([1, 2], 500, 5)).to.throw(/too short/);
      expect(() => empiricalInRangeFraction([1, 2, 3], 0, 1)).to.throw(/widthBps/);
    });

    it("§1.10 like-for-like: OFF-CENTRE bounds — empirical ≈ GBM analytic on the SAME bounds", () => {
      // The v1 divergence contamination (A8/F7/F12) came from comparing
      // a midpoint-convention empirical width against actual-bounds GBM.
      // Both estimators now integrate the ACTUAL bounds; on synthetic
      // GBM data with a deliberately asymmetric range about spot they
      // must agree — any residual systematic gap would mean the
      // divergence flag still compares different questions.
      const sigma = 0.6;
      const dt = 1 / 365;
      let state = 98765;
      const rng = () => {
        state |= 0; state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const closes = [100];
      for (let i = 0; i < 20_000; i++) {
        const u1 = Math.max(rng(), 1e-12);
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
        closes.push(closes[closes.length - 1] * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z));
      }

      // Asymmetric range: −4% / +12% around spot (spot far off midpoint).
      const spot = 100;
      const pL = 96;
      const pU = 112;
      const horizon = 7;
      const emp = empiricalInRangeFractionBounds(closes, pL, pU, spot, horizon);

      // GBM analytic on the SAME bounds (mirrors core's
      // inRangeProbabilityBounds, averaged over the horizon steps).
      const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
      function erf(x: number): number {
        const s = x < 0 ? -1 : 1;
        x = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * x);
        const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return s * y;
      }
      let analytic = 0;
      for (let d = 1; d <= horizon; d++) {
        const T = d * dt;
        const mu = -0.5 * sigma * sigma;
        const sd = sigma * Math.sqrt(T);
        analytic +=
          Phi((Math.log(pU / spot) - mu * T) / sd) -
          Phi((Math.log(pL / spot) - mu * T) / sd);
      }
      analytic /= horizon;

      expect(emp.mean).to.be.closeTo(analytic, 0.03);
    });

    it("§1.5: meanCi is a deterministic block-bootstrap interval on the MEAN, far tighter than the outcome band", () => {
      // A wiggly deterministic series: enough windows that the mean is
      // precise while single-window outcomes still span widely.
      const closes = Array.from({ length: 365 }, (_, i) =>
        100 * Math.exp(0.05 * Math.sin(i / 3) + 0.02 * Math.sin(i / 11)),
      );
      const a = empiricalInRangeFraction(closes, 400, 7);
      const b = empiricalInRangeFraction(closes, 400, 7);
      // Deterministic (seeded) — regression-harness contract.
      expect(a.meanCi).to.deep.equal(b.meanCi);
      // The CI brackets the mean and is much tighter than the outcome
      // spread — that is the whole point of §1.5.
      expect(a.meanCi.p05).to.be.at.most(a.mean);
      expect(a.meanCi.p95).to.be.at.least(a.mean);
      expect(a.meanCi.p95 - a.meanCi.p05).to.be.lessThan((a.p95 - a.p05) * 0.5);
      // Effective sample size: windows/horizon, rounded.
      expect(a.nEffective).to.equal(Math.round(a.windows / 7));
    });
  });
});
