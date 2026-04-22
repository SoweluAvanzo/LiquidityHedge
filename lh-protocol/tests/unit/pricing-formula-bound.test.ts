/**
 * pricing-formula-bound.test.ts — MODEL-CONSISTENCY contract test.
 *
 * The off-chain `computeQuote()` MUST price with Gauss-Hermite Simpson
 * quadrature on the signed-swap payoff. The on-chain heuristic proxy
 * is retained for the future BPF runtime, but off-chain quoting MUST
 * be consistent with the theoretical fair value the paper defines.
 *
 * These tests are the guard: if anyone edits `computeQuote` to route
 * through the heuristic again, or to scale/clamp the FV in a way that
 * drifts from the theoretical model, these tests FAIL — loudly.
 *
 * Contract asserted (this file is the load-bearing contract):
 *   C1. `computeQuote().fairValueUsdc == computeGaussHermiteFV_E6(...)` exactly.
 *   C2. `computeQuote().premiumUsdc == max(P_floor, FV·m_vol − y·E[F])` exactly.
 *   C3. The heuristic is documented as under-pricing — the sweep shows the
 *       10× gap so future calibration work is visible.
 *   C4. At short tenor + tiny floor, the formula branch of max() activates;
 *       premium is formula-bound, not floor-bound.
 *
 * Any regression (accidental heuristic re-use, scaling bug, rounding drift
 * > 1 µUSDC) flips one of these assertions to red.
 */

import { expect } from "chai";
import {
  computeQuote,
  computeGaussHermiteFV_E6,
  computeHeuristicFV,
  computeFeeDiscount,
  computePremium,
} from "../../protocol-src/pricing-engine/pricing";
import { clPositionValue } from "../../protocol-src/pricing-engine/position-value";
import { calibrateSeverityForPool } from "../../protocol-src/risk-analyser/regime";
import { DEFAULT_MARKUP_FLOOR, PPM } from "../../protocol-src/types";
import type {
  PoolState,
  RegimeSnapshot,
  TemplateConfig,
} from "../../protocol-src/types";

/** Inputs mirror the live-orca-formula run (2026-04-21, σ≈0.699, S_0≈$85.50). */
const S0 = 85.5;
const WIDTH_BPS = 1000;
const TENOR_SECONDS_SHORT = 1800; // 30 minutes
const SIGMA = 0.699;
const SIGMA_PPM = Math.round(SIGMA * PPM);

// Position sizing (matches live-orca: ~$1.80 notional, L ≈ 2 normalized)
const NORMALISED_L = 2;
const P_L = S0 * 0.9;
const P_U = S0 * 1.1;
const V_S0 = clPositionValue(S0, NORMALISED_L, P_L, P_U); // ≈ $1.86
const ENTRY_VALUE_E6 = Math.floor(V_S0 * 1_000_000);
const NOTIONAL_USDC = ENTRY_VALUE_E6;

// Cap = V(S_0) − V(p_l) (natural downside cap)
const CAP_USDC = Math.floor(
  (V_S0 - clPositionValue(P_L, NORMALISED_L, P_L, P_U)) * 1_000_000,
);

// Template and pool state consistent with the live run
const TEMPLATE: TemplateConfig = {
  templateId: 99,
  widthBps: WIDTH_BPS,
  tenorSeconds: TENOR_SECONDS_SHORT,
  premiumCeilingUsdc: 500_000_000,
  expectedDailyFeeBps: 0,
};

/**
 * Two pool states:
 *   POOL_SMALL  — matches the live-orca PoC's $8 RT deposit. Known pathology:
 *                 with a $100 reference cap in calibrateSeverityForPool,
 *                 u_after = 1250% and capitalCharge dominates, forcing
 *                 severity to 1 ppm at every tenor.
 *   POOL_SIZED  — $1,000 RT reserves. Reference cap / reserves ≤ 10%,
 *                 so the capitalCharge term behaves as intended and
 *                 severity calibration is meaningful.
 */
const POOL_SMALL: PoolState = {
  reservesUsdc: 8_000_000, // $8 — matches live-orca PoC
  totalShares: 8_000_000,
  activeCapUsdc: 0,
  uMaxBps: 8_000,
  markupFloor: DEFAULT_MARKUP_FLOOR,
  feeSplitRate: 0.1,
  expectedDailyFee: 0.001377, // measurement-driven (Birdeye adapter)
  premiumFloorUsdc: 1,
  protocolFeeBps: 150,
  bump: 255,
};

const POOL_SIZED: PoolState = {
  ...POOL_SMALL,
  reservesUsdc: 1_000_000_000, // $1,000 — 10× reference cap
  totalShares: 1_000_000_000,
};

// Keep legacy alias pointing at POOL_SMALL so the earlier assertions
// still exercise the "collapsed" path they were written against.
const POOL = POOL_SMALL;

/** Calibrated severity for this 30-min regime — expected to collapse to 1. */
const SEVERITY_PPM = calibrateSeverityForPool(
  SIGMA_PPM,
  TEMPLATE,
  POOL,
  false,
  5,
);

const REGIME: RegimeSnapshot = {
  pool: "pool",
  sigmaPpm: SIGMA_PPM,
  sigma7dPpm: SIGMA_PPM,
  stressFlag: false,
  carryBpsPerDay: 5,
  severityPpm: SEVERITY_PPM,
  ivRvRatio: 1.08,
  effectiveMarkup: 1.08,
  updatedAt: 0,
  bump: 255,
};

describe("Formula-bound premium with real Gauss-Hermite FV", () => {
  // ────────────────────────────────────────────────────────────────
  // MODEL-CONSISTENCY CONTRACT
  //
  // These four assertions guard against any drift between the off-chain
  // quote and the paper's theoretical fair value. Touch computeQuote()
  // at your peril — these must stay green.
  // ────────────────────────────────────────────────────────────────

  describe("Model-consistency contract (off-chain quote ≡ GH quadrature)", () => {
    const tenors = [
      { label: "30 min", seconds: 1800 },
      { label: "1 day", seconds: 86_400 },
      { label: "7 days", seconds: 7 * 86_400 },
      { label: "14 days", seconds: 14 * 86_400 },
    ];
    for (const t of tenors) {
      it(`C1. computeQuote.fairValueUsdc === computeGaussHermiteFV_E6 (at ${t.label})`, () => {
        const tpl: TemplateConfig = { ...TEMPLATE, tenorSeconds: t.seconds };
        const ghDirect = computeGaussHermiteFV_E6(
          Math.floor(S0 * 1_000_000),
          SIGMA_PPM,
          NORMALISED_L,
          Math.floor(P_L * 1_000_000),
          Math.floor(P_U * 1_000_000),
          t.seconds,
        );
        const quote = computeQuote(
          {
            entryPriceE6: Math.floor(S0 * 1_000_000),
            notionalUsdc: ENTRY_VALUE_E6,
            liquidity: NORMALISED_L,
            pL: P_L,
            pU: P_U,
          },
          tpl,
          POOL_SIZED,
          REGIME,
        );
        expect(quote).to.not.be.null;
        // EXACT match — 0 µUSDC tolerance. If this drifts, quoting code
        // changed the FV path (to heuristic, to a scaled GH, to some
        // other quadrature, etc.) and the paper's claims need revisiting.
        expect(quote!.fairValueUsdc).to.equal(
          ghDirect,
          `computeQuote FV diverged from GH at ${t.label}: ` +
            `quote=${quote!.fairValueUsdc} vs gh=${ghDirect}`,
        );
      });
    }

    it("C2. computeQuote.premiumUsdc === max(P_floor, FV·m_vol − y·E[F]) (canonical formula)", () => {
      const tpl: TemplateConfig = {
        ...TEMPLATE,
        tenorSeconds: 7 * 86_400,
      };
      const poolWithFloor: PoolState = {
        ...POOL_SIZED,
        premiumFloorUsdc: 100, // small floor so the formula branch activates
      };
      const quote = computeQuote(
        {
          entryPriceE6: Math.floor(S0 * 1_000_000),
          notionalUsdc: ENTRY_VALUE_E6,
          liquidity: NORMALISED_L,
          pL: P_L,
          pU: P_U,
        },
        tpl,
        poolWithFloor,
        REGIME,
      );
      expect(quote).to.not.be.null;
      const expectedFeeDiscount = computeFeeDiscount(
        ENTRY_VALUE_E6,
        poolWithFloor.expectedDailyFee,
        poolWithFloor.feeSplitRate,
        tpl.tenorSeconds / 86_400,
      );
      const expectedPremium = computePremium(
        quote!.fairValueUsdc,
        REGIME.effectiveMarkup,
        expectedFeeDiscount,
        poolWithFloor.premiumFloorUsdc,
      );
      expect(quote!.premiumUsdc).to.equal(expectedPremium);
      expect(quote!.feeDiscountUsdc).to.equal(expectedFeeDiscount);
      // Formula branch must be picking: verify the formula value beats floor.
      const formulaRaw = Math.floor(
        quote!.fairValueUsdc * REGIME.effectiveMarkup - expectedFeeDiscount,
      );
      expect(formulaRaw).to.be.greaterThan(poolWithFloor.premiumFloorUsdc);
      expect(quote!.premiumUsdc).to.equal(formulaRaw);
    });

    it("C3. the heuristic proxy is kept intact but does NOT equal the production FV", () => {
      // Heuristic must still be callable (future on-chain use). And it
      // must systematically produce a different value from computeQuote
      // (the whole point of this refactor) — this guards against someone
      // "fixing" the discrepancy by silently re-wiring computeQuote back
      // to the heuristic. Heuristic is ALLOWED to drift; production quote
      // is NOT.
      const tpl: TemplateConfig = { ...TEMPLATE, tenorSeconds: 7 * 86_400 };
      const heuristic = computeHeuristicFV(
        CAP_USDC,
        tpl,
        POOL_SIZED,
        REGIME,
      );
      const quote = computeQuote(
        {
          entryPriceE6: Math.floor(S0 * 1_000_000),
          notionalUsdc: ENTRY_VALUE_E6,
          liquidity: NORMALISED_L,
          pL: P_L,
          pU: P_U,
        },
        tpl,
        POOL_SIZED,
        REGIME,
      );
      expect(heuristic).to.not.be.null;
      expect(quote).to.not.be.null;
      expect(quote!.fairValueUsdc).to.not.equal(heuristic!.totalUsdc);
      // And the production FV must be the LARGER of the two (paper's
      // theoretical FV bounds the heuristic from above for this regime).
      expect(quote!.fairValueUsdc).to.be.greaterThan(heuristic!.totalUsdc);
    });

    it("C4. computeQuote returns null when utilization would exceed uMax (headroom guard)", () => {
      const tpl: TemplateConfig = { ...TEMPLATE, tenorSeconds: 7 * 86_400 };
      // A pool with almost no reserves — any cap blows through uMax.
      const tightPool: PoolState = {
        ...POOL_SIZED,
        reservesUsdc: 1_000, // 0.001 USDC
        uMaxBps: 100, // 1%
      };
      const quote = computeQuote(
        {
          entryPriceE6: Math.floor(S0 * 1_000_000),
          notionalUsdc: ENTRY_VALUE_E6,
          liquidity: NORMALISED_L,
          pL: P_L,
          pU: P_U,
        },
        tpl,
        tightPool,
        REGIME,
      );
      expect(quote).to.be.null;
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Diagnostic / exploratory tests (retained for paper-grade evidence)
  // ────────────────────────────────────────────────────────────────

  it("confirms the heuristic severity calibration collapses at 30-min tenor (severity → 1 ppm)", () => {
    // The fairValueProxy (quadratic in √T) is dominated by capitalCharge
    // at short tenors → ePayoutTarget ≤ 0 → severity clamped to floor.
    expect(SEVERITY_PPM).to.be.lessThan(100); // essentially 1 ppm
  });

  it("heuristic FV at 30-min tenor collapses to only the capital-charge term (≤ 15 µUSDC)", () => {
    const heuristic = computeHeuristicFV(CAP_USDC, TEMPLATE, POOL, REGIME);
    expect(heuristic).to.not.be.null;
    // With severity=1, expectedPayout rounds to 0; capitalCharge dominates.
    expect(heuristic!.expectedPayoutUsdc).to.equal(0);
    expect(heuristic!.totalUsdc).to.be.lessThan(15);
  });

  it("real Gauss-Hermite FV is at least an order of magnitude larger than the heuristic", () => {
    const ghFV = computeGaussHermiteFV_E6(
      Math.floor(S0 * 1_000_000),
      SIGMA_PPM,
      NORMALISED_L,
      Math.floor(P_L * 1_000_000),
      Math.floor(P_U * 1_000_000),
      TENOR_SECONDS_SHORT,
    );
    const heuristic = computeHeuristicFV(CAP_USDC, TEMPLATE, POOL, REGIME)!;
    expect(ghFV).to.be.greaterThan(heuristic.totalUsdc * 10);
    // Sanity: convexity-wedge analytical estimate −V''(S_0)/2 · S_0² · σ² · T.
    // V''(S_0) ≈ −L / (2·S_0^1.5) for in-range CL positions.
    const Vdd = -NORMALISED_L / (2 * Math.pow(S0, 1.5));
    const tenorYears = TENOR_SECONDS_SHORT / (365 * 86_400);
    const analyticalFV =
      (-Vdd / 2) * S0 * S0 * SIGMA * SIGMA * tenorYears;
    const analyticalFV_E6 = analyticalFV * 1_000_000;
    // GH must be within 3× of the analytical estimate (same order of magnitude).
    expect(ghFV / analyticalFV_E6).to.be.within(0.3, 3.0);
  });

  it("with the real GH FV, the canonical formula branch BEATS a small P_floor — formula-bound premium", () => {
    const ghFV = computeGaussHermiteFV_E6(
      Math.floor(S0 * 1_000_000),
      SIGMA_PPM,
      NORMALISED_L,
      Math.floor(P_L * 1_000_000),
      Math.floor(P_U * 1_000_000),
      TENOR_SECONDS_SHORT,
    );
    const feeDiscount = computeFeeDiscount(
      NOTIONAL_USDC,
      POOL.expectedDailyFee,
      POOL.feeSplitRate,
      TENOR_SECONDS_SHORT / 86_400,
    );
    const formulaRaw = Math.floor(ghFV * REGIME.effectiveMarkup - feeDiscount);
    // Set P_floor to 0.0005% of V(S_0) — the "formula-mode" wrapper value.
    const pFloor = Math.max(1, Math.floor(NOTIONAL_USDC * 0.000005));

    const premium = computePremium(
      ghFV,
      REGIME.effectiveMarkup,
      feeDiscount,
      pFloor,
    );

    // The formula branch must win (premium > pFloor means max() picked it).
    expect(premium).to.equal(formulaRaw);
    expect(premium).to.be.greaterThan(pFloor);
    // And premium must be a sensible value (not zero, not catastrophic).
    expect(premium).to.be.greaterThan(10); // > 10 µUSDC
    expect(premium).to.be.lessThan(NOTIONAL_USDC); // obviously < position value
  });

  it("parametric sweep: heuristic is collapsed at ALL tenors when pool reserves are too small (PoC config)", () => {
    const tenors = [
      { label: "30 min", seconds: 1800 },
      { label: "1 day", seconds: 86_400 },
      { label: "3 days", seconds: 3 * 86_400 },
      { label: "7 days", seconds: 7 * 86_400 },
      { label: "14 days", seconds: 14 * 86_400 },
    ];
    const rows = buildSweepRows(tenors, POOL_SMALL);
    // eslint-disable-next-line no-console
    console.log(
      "\n    Heuristic vs GH-quadrature, POOL_SMALL ($8 reserves — live-orca PoC):",
    );
    // eslint-disable-next-line no-console
    console.table(rows);
    // Every row should be collapsed (severity=1, heuristic ≪ GH).
    for (const r of rows) {
      expect(r.severity).to.equal(1);
      expect(Number(r.ratio)).to.be.lessThan(0.1);
    }
  });

  it("parametric sweep: on a larger pool severity recovers but the heuristic is still systematically ~10× too small", () => {
    const tenors = [
      { label: "30 min", seconds: 1800 },
      { label: "1 day", seconds: 86_400 },
      { label: "3 days", seconds: 3 * 86_400 },
      { label: "7 days", seconds: 7 * 86_400 },
      { label: "14 days", seconds: 14 * 86_400 },
    ];
    const rows = buildSweepRows(tenors, POOL_SIZED);
    // eslint-disable-next-line no-console
    console.log(
      "\n    Heuristic vs GH-quadrature, POOL_SIZED ($1,000 reserves — realistic):",
    );
    // eslint-disable-next-line no-console
    console.table(rows);
    // Recovery: severity is no longer pinned at 1 ppm for day-plus tenors.
    const sevenDay = rows.find((r) => r.tenor === "7 days")!;
    expect(sevenDay.severity).to.be.greaterThan(1_000);
    // But the on-chain heuristic still under-estimates GH by roughly an order
    // of magnitude. This is the documented limitation of the proxy; the paper's
    // theoretical premium uses the GH quadrature (sensitivity analysis). This
    // assertion LOCKS IN the current calibration so future changes are visible.
    const ratio = Number(sevenDay.ratio);
    expect(ratio).to.be.within(
      0.05,
      0.2,
      `7-day heuristic is expected to under-price by ~10× (ratio in [0.05, 0.2]); ` +
        `got ${sevenDay.ratio} — if this changed, the severity calibration or ` +
        `fairValueProxy was modified and the paper's claims about the heuristic ` +
        `bound need revisiting.`,
    );
  });

  it("diagnostic: full breakdown (visible in mocha --reporter spec)", () => {
    const ghFV = computeGaussHermiteFV_E6(
      Math.floor(S0 * 1_000_000),
      SIGMA_PPM,
      NORMALISED_L,
      Math.floor(P_L * 1_000_000),
      Math.floor(P_U * 1_000_000),
      TENOR_SECONDS_SHORT,
    );
    const heuristic = computeHeuristicFV(CAP_USDC, TEMPLATE, POOL, REGIME)!;
    const feeDiscount = computeFeeDiscount(
      NOTIONAL_USDC,
      POOL.expectedDailyFee,
      POOL.feeSplitRate,
      TENOR_SECONDS_SHORT / 86_400,
    );
    const pFloor = Math.max(1, Math.floor(NOTIONAL_USDC * 0.000005));
    const premium = computePremium(
      ghFV,
      REGIME.effectiveMarkup,
      feeDiscount,
      pFloor,
    );

    // The diagnostic numbers; test only verifies they exist.
    const report = {
      S0,
      sigma: SIGMA,
      tenorMinutes: TENOR_SECONDS_SHORT / 60,
      V_S0,
      cap: CAP_USDC / 1e6,
      calibrated_severity_ppm: SEVERITY_PPM,
      heuristic_FV_µUSDC: heuristic.totalUsdc,
      gauss_hermite_FV_µUSDC: ghFV,
      ratio_GH_over_heuristic: ghFV / Math.max(1, heuristic.totalUsdc),
      m_vol: REGIME.effectiveMarkup,
      fee_discount_µUSDC: feeDiscount,
      formula_raw_µUSDC: Math.floor(
        ghFV * REGIME.effectiveMarkup - feeDiscount,
      ),
      P_floor_µUSDC: pFloor,
      premium_µUSDC: premium,
      formula_bound: premium > pFloor,
    };
    // eslint-disable-next-line no-console
    console.log("\n    Formula-bound pricing report:", JSON.stringify(report, null, 2));
    expect(report.formula_bound).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: tenor sweep
// ---------------------------------------------------------------------------

interface SweepRow {
  tenor: string;
  severity: number;
  heuristic_uUSDC: number;
  gh_uUSDC: number;
  ratio: string;
  reliable: boolean;
}

function buildSweepRows(
  tenors: { label: string; seconds: number }[],
  pool: PoolState,
): SweepRow[] {
  return tenors.map((t) => {
    const tpl: TemplateConfig = { ...TEMPLATE, tenorSeconds: t.seconds };
    const sev = calibrateSeverityForPool(SIGMA_PPM, tpl, pool, false, 5);
    const reg: RegimeSnapshot = { ...REGIME, severityPpm: sev };
    const heuristic = computeHeuristicFV(CAP_USDC, tpl, pool, reg)!;
    const gh = computeGaussHermiteFV_E6(
      Math.floor(S0 * 1_000_000),
      SIGMA_PPM,
      NORMALISED_L,
      Math.floor(P_L * 1_000_000),
      Math.floor(P_U * 1_000_000),
      t.seconds,
    );
    const ratio = gh > 0 ? heuristic.totalUsdc / gh : 0;
    return {
      tenor: t.label,
      severity: sev,
      heuristic_uUSDC: heuristic.totalUsdc,
      gh_uUSDC: gh,
      ratio: ratio.toFixed(3),
      reliable: ratio >= 0.5 && ratio <= 2.0,
    };
  });
}
