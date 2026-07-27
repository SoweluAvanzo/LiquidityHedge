import { expect } from "chai";
import {
  computePremium,
  computeFeeDiscount,
  computeQuadratureFV,
  quadratureExpectation,
} from "../../src/pricing-engine/pricing";
import { computeHeuristicFV } from "../../src/pricing-engine/heuristic-fv";
import { resolveEffectiveMarkup } from "../../src/risk-analyser/regime";
import { naturalCap, lhPayoff } from "../../src/pricing-engine/position-value";
import { makePool, makeTemplate, makeRegime } from "../helpers";

describe("Pricing Engine", () => {
  // ── Canonical premium formula ─────────────────────────────

  describe("computePremium: Premium = max(P_floor, FV * m_vol - y * E[F])", () => {
    it("returns P_floor when FV*m_vol - discount < P_floor", () => {
      const premium = computePremium(10_000, 1.05, 50_000, 50_000);
      // 10_000 * 1.05 - 50_000 = -39_500 < 50_000
      expect(premium).to.equal(50_000);
    });

    it("returns FV*m_vol - discount when that exceeds P_floor", () => {
      const premium = computePremium(1_000_000, 1.10, 100_000, 50_000);
      // 1_000_000 * 1.10 - 100_000 = 1_000_000
      expect(premium).to.equal(1_000_000);
    });

    it("premium >= P_floor always", () => {
      const premiumFloor = 50_000;
      // Even with zero FV
      expect(computePremium(0, 1.05, 0, premiumFloor)).to.be.greaterThanOrEqual(premiumFloor);
      // Even with large discount
      expect(computePremium(100_000, 1.05, 500_000, premiumFloor)).to.be.greaterThanOrEqual(premiumFloor);
    });

    it("premium increases with FV", () => {
      const p1 = computePremium(500_000, 1.10, 50_000, 50_000);
      const p2 = computePremium(1_000_000, 1.10, 50_000, 50_000);
      expect(p2).to.be.greaterThan(p1);
    });

    it("premium increases with m_vol", () => {
      const p1 = computePremium(500_000, 1.05, 50_000, 50_000);
      const p2 = computePremium(500_000, 1.20, 50_000, 50_000);
      expect(p2).to.be.greaterThan(p1);
    });

    it("premium decreases with fee discount", () => {
      const p1 = computePremium(500_000, 1.10, 0, 50_000);
      const p2 = computePremium(500_000, 1.10, 100_000, 50_000);
      expect(p2).to.be.lessThan(p1);
    });
  });

  // ── Effective markup ──────────────────────────────────────

  describe("resolveEffectiveMarkup: m_vol = max(floor, IV/RV)", () => {
    it("returns floor when ivRvRatio < floor", () => {
      expect(resolveEffectiveMarkup(1.02, 1.05)).to.equal(1.05);
    });

    it("returns ivRvRatio when ivRvRatio > floor", () => {
      expect(resolveEffectiveMarkup(1.15, 1.05)).to.equal(1.15);
    });

    it("returns floor when ivRvRatio = 0 (unavailable)", () => {
      expect(resolveEffectiveMarkup(0, 1.05)).to.equal(1.05);
    });

    it("returns floor when ivRvRatio = floor", () => {
      expect(resolveEffectiveMarkup(1.05, 1.05)).to.equal(1.05);
    });
  });

  // ── Fee discount ──────────────────────────────────────────

  describe("computeFeeDiscount: y * E[F]", () => {
    it("fee discount = y * notional * dailyFee * tenorDays", () => {
      // y=0.10, notional=$30, dailyFee=0.005, tenor=7 days
      const discount = computeFeeDiscount(30_000_000, 0.005, 0.10, 7);
      // 30_000_000 * 0.005 * 7 * 0.10 = 105_000
      expect(discount).to.equal(105_000);
    });

    it("fee discount = 0 when feeSplitRate = 0", () => {
      expect(computeFeeDiscount(30_000_000, 0.005, 0, 7)).to.equal(0);
    });

    it("fee discount increases with fee split rate", () => {
      const d1 = computeFeeDiscount(30_000_000, 0.005, 0.05, 7);
      const d2 = computeFeeDiscount(30_000_000, 0.005, 0.15, 7);
      expect(d2).to.be.greaterThan(d1);
    });
  });

  // ── Heuristic fair-value proxy ────────────────────────────

  describe("computeHeuristicFV", () => {
    it("produces positive FV for standard inputs", () => {
      const pool = makePool();
      const template = makeTemplate();
      const regime = makeRegime();
      const heuristic = computeHeuristicFV(5_000_000, template, pool, regime);
      expect(heuristic).to.not.be.null;
      expect(heuristic!.totalUsdc).to.be.greaterThan(0);
    });

    it("returns null when utilization exceeded", () => {
      const pool = makePool({ reservesUsdc: 1_000_000, activeCapUsdc: 500_000 });
      const template = makeTemplate();
      const regime = makeRegime();
      // Cap of $50 on $1 pool at 30% u_max → exceeds
      const heuristic = computeHeuristicFV(50_000_000, template, pool, regime);
      expect(heuristic).to.be.null;
    });

    it("FV increases with volatility", () => {
      const pool = makePool();
      const template = makeTemplate();
      const r1 = makeRegime({ sigmaPpm: 400_000 });
      const r2 = makeRegime({ sigmaPpm: 800_000 });
      const fv1 = computeHeuristicFV(5_000_000, template, pool, r1)!.totalUsdc;
      const fv2 = computeHeuristicFV(5_000_000, template, pool, r2)!.totalUsdc;
      expect(fv2).to.be.greaterThan(fv1);
    });

    it("FV increases with cap", () => {
      const pool = makePool();
      const template = makeTemplate();
      const regime = makeRegime();
      const fv1 = computeHeuristicFV(2_000_000, template, pool, regime)!.totalUsdc;
      const fv2 = computeHeuristicFV(8_000_000, template, pool, regime)!.totalUsdc;
      expect(fv2).to.be.greaterThan(fv1);
    });

    it("stress flag adds adverse selection charge (cap/10)", () => {
      const pool = makePool();
      const template = makeTemplate();
      const noStress = makeRegime({ stressFlag: false });
      const stress = makeRegime({ stressFlag: true });
      const fvNoStress = computeHeuristicFV(5_000_000, template, pool, noStress)!;
      const fvStress = computeHeuristicFV(5_000_000, template, pool, stress)!;
      expect(fvStress.adverseSelectionUsdc).to.equal(500_000); // 5M / 10
      expect(fvNoStress.adverseSelectionUsdc).to.equal(0);
      expect(fvStress.totalUsdc).to.be.greaterThan(fvNoStress.totalUsdc);
    });

    it("components sum to total (before ceiling)", () => {
      const pool = makePool();
      const template = makeTemplate();
      const regime = makeRegime();
      const h = computeHeuristicFV(5_000_000, template, pool, regime)!;
      const sum = h.expectedPayoutUsdc + h.capitalChargeUsdc +
                  h.adverseSelectionUsdc + h.replicationCostUsdc;
      expect(h.totalUsdc).to.equal(sum);
    });

    it("FV decreases with wider width", () => {
      const pool = makePool();
      const regime = makeRegime();
      const narrow = makeTemplate({ widthBps: 500 });
      const wide = makeTemplate({ widthBps: 1500 });
      const fv1 = computeHeuristicFV(5_000_000, narrow, pool, regime)!.totalUsdc;
      const fv2 = computeHeuristicFV(5_000_000, wide, pool, regime)!.totalUsdc;
      expect(fv1).to.be.greaterThan(fv2);
    });
  });

  // ── Gauss-Hermite quadrature FV ───────────────────────────

  describe("computeQuadratureFV (swap FV = E_Q[V(S_0) − V(clamp(S_T))])", () => {
    const L = 10_000;
    const pL = 135;
    const pU = 165;
    const S0 = 150;
    const capDown = naturalCap(S0, L, pL, pU);

    it("FV > 0 for realistic volatility (Jensen on concave V)", () => {
      const fv = computeQuadratureFV(S0, 0.65, L, pL, pU);
      expect(fv).to.be.greaterThan(0);
    });

    it("FV increases with volatility (more convexity exploited)", () => {
      const fv1 = computeQuadratureFV(S0, 0.40, L, pL, pU);
      const fv2 = computeQuadratureFV(S0, 0.80, L, pL, pU);
      expect(fv2).to.be.greaterThan(fv1);
    });

    it("FV <= Cap_down (bounded by downside leg)", () => {
      const fv = computeQuadratureFV(S0, 1.50, L, pL, pU);
      expect(fv).to.be.lessThanOrEqual(capDown + 0.01);
    });

    it("FV approaches 0 as volatility approaches 0", () => {
      const fvHigh = computeQuadratureFV(S0, 0.65, L, pL, pU);
      const fvLow = computeQuadratureFV(S0, 0.05, L, pL, pU);
      expect(fvLow).to.be.lessThan(fvHigh * 0.1);
    });
  });

  // ── Generic quadrature expectation (§1.3) ─────────────────

  describe("quadratureExpectation (E_Q[g(S_T)] under risk-neutral GBM)", () => {
    const S0 = 150;
    const sigma = 0.65;
    const T = 7 / 365;

    it("martingale: E[S_T − S_0] ≈ 0 — the term that broke the MC estimator", () => {
      // Under 20k-path MC this linear term had 8–108% relative SE; the
      // quadrature resolves it to numerical noise.
      const e = quadratureExpectation((sT) => sT - S0, S0, sigma, T);
      expect(Math.abs(e)).to.be.lessThan(S0 * 1e-9);
    });

    it("normalisation: E[1] = 1 up to the z∈[−6,6] truncation (2Φ(−6) ≈ 2e-9)", () => {
      const e = quadratureExpectation(() => 1, S0, sigma, T);
      expect(e).to.be.closeTo(1, 1e-8);
      expect(e).to.be.lessThan(1); // truncation only ever removes mass
    });

    it("computeQuadratureFV ≡ max(0, quadratureExpectation(payoff)) exactly", () => {
      const L = 10_000;
      const pL = 135;
      const pU = 165;
      const viaGeneric = Math.max(
        0,
        quadratureExpectation((sT) => lhPayoff(sT, S0, L, pL, pU), S0, sigma, T),
      );
      expect(computeQuadratureFV(S0, sigma, L, pL, pU, T)).to.equal(viaGeneric);
    });

    it("known value: lognormal mean under drift −σ²T/2 · e^{σ²T} leg", () => {
      // E[S_T²] = S0²·e^{σ²T} exactly for GBM (martingale in S, not S²).
      const e2 = quadratureExpectation((sT) => sT * sT, S0, sigma, T);
      expect(e2).to.be.closeTo(S0 * S0 * Math.exp(sigma * sigma * T), S0 * S0 * 1e-6);
    });

    it("§1.6 drift sweep: E[S_T] = S0·e^{μT} under physical drift μ, and μ=0 is bit-identical to the default", () => {
      const mu = 0.5; // +50%/yr
      const eUp = quadratureExpectation((sT) => sT, S0, sigma, T, undefined, mu);
      expect(eUp).to.be.closeTo(S0 * Math.exp(mu * T), S0 * 1e-6);
      const eDn = quadratureExpectation((sT) => sT, S0, sigma, T, undefined, -mu);
      expect(eDn).to.be.closeTo(S0 * Math.exp(-mu * T), S0 * 1e-6);
      // The default path must not move by a single ulp: the sweep is a
      // display feature, never a repricing.
      const impl = quadratureExpectation((sT) => sT - S0, S0, sigma, T);
      const expl = quadratureExpectation((sT) => sT - S0, S0, sigma, T, undefined, 0);
      expect(impl).to.equal(expl);
    });
  });

  // ── Monotonicity properties ───────────────────────────────

  describe("Premium monotonicity (end-to-end)", () => {
    it("premium increases with volatility (higher sigma → higher FV → higher premium)", () => {
      const pool = makePool();
      const template = makeTemplate();
      const r1 = makeRegime({ sigmaPpm: 400_000 });
      const r2 = makeRegime({ sigmaPpm: 900_000 });

      const fv1 = computeHeuristicFV(5_000_000, template, pool, r1)!.totalUsdc;
      const fv2 = computeHeuristicFV(5_000_000, template, pool, r2)!.totalUsdc;
      const p1 = computePremium(fv1, 1.08, 100_000, 50_000);
      const p2 = computePremium(fv2, 1.08, 100_000, 50_000);
      expect(p2).to.be.greaterThan(p1);
    });
  });
});
