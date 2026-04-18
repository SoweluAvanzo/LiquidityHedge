import { expect } from "chai";
import {
  computePremium,
  computeFeeDiscount,
  computeHeuristicFV,
  computeGaussHermiteFV,
} from "../../protocol-src/operations/pricing";
import { resolveEffectiveMarkup } from "../../protocol-src/operations/regime";
import { naturalCap } from "../../protocol-src/utils/position-value";
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

  describe("computeGaussHermiteFV", () => {
    const L = 10_000;
    const pL = 135;
    const pU = 165;
    const S0 = 150;
    const cap = naturalCap(S0, L, pL, pU);

    it("FV > 0 for realistic volatility", () => {
      const fv = computeGaussHermiteFV(S0, 0.65, L, pL, pU, cap);
      expect(fv).to.be.greaterThan(0);
    });

    it("FV increases with volatility", () => {
      const fv1 = computeGaussHermiteFV(S0, 0.40, L, pL, pU, cap);
      const fv2 = computeGaussHermiteFV(S0, 0.80, L, pL, pU, cap);
      expect(fv2).to.be.greaterThan(fv1);
    });

    it("FV <= cap (bounded by maximum payout)", () => {
      const fv = computeGaussHermiteFV(S0, 1.50, L, pL, pU, cap);
      expect(fv).to.be.lessThanOrEqual(cap + 0.01);
    });

    it("FV approaches 0 as volatility approaches 0", () => {
      const fvHigh = computeGaussHermiteFV(S0, 0.65, L, pL, pU, cap);
      const fvLow = computeGaussHermiteFV(S0, 0.05, L, pL, pU, cap);
      expect(fvLow).to.be.lessThan(fvHigh * 0.1);
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
