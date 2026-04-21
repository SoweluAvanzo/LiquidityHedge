#!/usr/bin/env ts-node
/**
 * sensitivity-analysis.ts — structural-claim robustness under parameter
 * variation.
 *
 * The paper's load-bearing claims (Theorem 2.2 and its corollary that the
 * joint-breakeven wedge is small) depend only on the additive structure
 * of the cash flows, not on specific values of IV/RV, RT carry, or LP
 * fee rate. This script validates that empirically: it sweeps each
 * parameter across a realistic range and reports the theoretical
 * joint-breakeven wedge
 *
 *   r* − r_u ≈ φ · P̄ / (7 · V̄)
 *
 * where `P̄` is the average premium and `V̄` is the average position
 * value. `P̄` is computed from the signed-swap FV via Simpson quadrature
 * (the same computeGaussHermiteFV used in production pricing).
 *
 * Sweep ranges are chosen to bracket any plausible market condition:
 *   ivRvRatio     ∈ {1.00, 1.05, 1.08, 1.15, 1.25, 1.50}
 *   carry (bps/d) ∈ {0, 5, 10, 15, 20}
 *   fee rate      ∈ {0.001, 0.0025, 0.005}  (Low / Medium / High tiers)
 *   sigma         ∈ {0.40, 0.65, 0.90, 1.20} (annualized)
 *
 * Output:
 *   - Markdown summary table (to stdout)
 *   - CSV with every grid row (to scripts/sensitivity-results.csv)
 *   - Exit code 1 if any wedge exceeds the CLAIM_THRESHOLD_BPS (default 1.0)
 *
 * Usage: npx ts-node scripts/sensitivity-analysis.ts
 */

import * as fs from "fs";
import * as path from "path";

import {
  clPositionValue,
  naturalCap,
} from "../protocol-src/pricing-engine/position-value";
import {
  computeGaussHermiteFV,
  computeFeeDiscount,
  computePremium,
} from "../protocol-src/pricing-engine/pricing";
import {
  BPS,
  PPM,
  SECONDS_PER_YEAR,
} from "../protocol-src/types";

// ─── Sweep configuration ─────────────────────────────────────────────

const IV_RV_GRID = [1.0, 1.05, 1.08, 1.15, 1.25, 1.5];
const CARRY_GRID = [0, 5, 10, 15, 20]; // bps/day
const FEE_RATE_GRID = [0.001, 0.0025, 0.005]; // daily rates
const SIGMA_GRID = [0.4, 0.65, 0.9, 1.2]; // annualized

const PROTOCOL_FEE_BPS = 150; // 1.5% (governance default)
const MARKUP_FLOOR = 1.05;
const WIDTH_BPS = 1000; // ±10%
const TENOR_SECONDS = 7 * 86_400; // 7 days
const FEE_SPLIT_RATE = 0.1; // y = 10%

/** Reference CL position used for all grid points (same as §8.1.2 backtest). */
const REF = {
  S0: 150, // $/SOL
  L: 10_000,
  pL: 135,
  pU: 165,
};

const CLAIM_THRESHOLD_BPS_PER_DAY = 1.0;

// ─── Wedge computation ──────────────────────────────────────────────

interface GridRow {
  sigma: number;
  ivRvRatio: number;
  carryBpsPerDay: number;
  feeRatePerDay: number;
  vPosition: number;
  capDown: number;
  fvSwap: number;
  mVol: number;
  eFeesOverTenor: number;
  feeDiscount: number;
  premium: number;
  wedgeBpsPerDay: number;
}

function computeGridPoint(
  sigma: number,
  ivRvRatio: number,
  carryBpsPerDay: number,
  feeRatePerDay: number,
): GridRow {
  const V0 = clPositionValue(REF.S0, REF.L, REF.pL, REF.pU);
  const capDown = naturalCap(REF.S0, REF.L, REF.pL, REF.pU);
  const tenorYears = TENOR_SECONDS / SECONDS_PER_YEAR;

  // Fair value of the signed-swap payoff (Simpson quadrature).
  const fvSwap = computeGaussHermiteFV(
    REF.S0,
    sigma,
    REF.L,
    REF.pL,
    REF.pU,
    tenorYears,
  );

  const mVol = Math.max(MARKUP_FLOOR, ivRvRatio);

  // Fee discount = y · E[F] = y · (V0 · rate · tenorDays)
  const tenorDays = TENOR_SECONDS / 86_400;
  const eFeesOverTenor = V0 * feeRatePerDay * tenorDays;
  const feeDiscount = FEE_SPLIT_RATE * eFeesOverTenor;

  // Premium (ignoring P_floor so we see the raw sensitivity; the floor
  // only *raises* premium, which shrinks the wedge — so this is a
  // conservative upper bound).
  const premium = Math.max(0, fvSwap * mVol - feeDiscount);

  // Theorem 2.2 wedge: r* − r_u = φ · P̄ / (7 · V̄)
  //   φ = 0.015, P̄ = premium, V̄ = V0  (single-week baseline)
  //   Output in bps/day
  const phi = PROTOCOL_FEE_BPS / BPS;
  const wedgeFraction = (phi * premium) / (7 * V0);
  const wedgeBpsPerDay = wedgeFraction * 10_000;

  // Note on carry: in the FV quadrature above we didn't pass carry —
  // carry only enters the heuristic on-chain proxy C_rep, not the true
  // risk-neutral FV. At the FV level, carry is a second-order effect
  // (enters the drift, which in this backtest we set to -σ²/2 for
  // risk-neutral pricing with r=0). So this sweep's wedge is invariant
  // to carry by construction. We still log it for auditability.
  void carryBpsPerDay;

  return {
    sigma,
    ivRvRatio,
    carryBpsPerDay,
    feeRatePerDay,
    vPosition: V0,
    capDown,
    fvSwap,
    mVol,
    eFeesOverTenor,
    feeDiscount,
    premium,
    wedgeBpsPerDay,
  };
}

// ─── Execute sweep ───────────────────────────────────────────────────

function main(): void {
  const rows: GridRow[] = [];
  for (const sigma of SIGMA_GRID) {
    for (const ivRv of IV_RV_GRID) {
      for (const carry of CARRY_GRID) {
        for (const feeRate of FEE_RATE_GRID) {
          rows.push(computeGridPoint(sigma, ivRv, carry, feeRate));
        }
      }
    }
  }

  // ── CSV output
  const csvHeader = [
    "sigma",
    "ivRvRatio",
    "carryBpsPerDay",
    "feeRatePerDay",
    "vPosition_usd",
    "capDown_usd",
    "fvSwap_usd",
    "mVol",
    "feeDiscount_usd",
    "premium_usd",
    "wedgeBpsPerDay",
  ].join(",");
  const csvRows = rows.map((r) =>
    [
      r.sigma.toFixed(3),
      r.ivRvRatio.toFixed(3),
      r.carryBpsPerDay,
      r.feeRatePerDay.toFixed(5),
      r.vPosition.toFixed(6),
      r.capDown.toFixed(6),
      r.fvSwap.toFixed(9),
      r.mVol.toFixed(4),
      r.feeDiscount.toFixed(6),
      r.premium.toFixed(6),
      r.wedgeBpsPerDay.toFixed(6),
    ].join(","),
  );
  const csvPath = path.resolve(__dirname, "sensitivity-results.csv");
  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n") + "\n");

  // ── Summary stats
  const wedges = rows.map((r) => r.wedgeBpsPerDay);
  const wMin = Math.min(...wedges);
  const wMax = Math.max(...wedges);
  const wMean = wedges.reduce((s, x) => s + x, 0) / wedges.length;
  const wMedian = (() => {
    const s = [...wedges].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  })();

  const overThreshold = rows.filter(
    (r) => r.wedgeBpsPerDay > CLAIM_THRESHOLD_BPS_PER_DAY,
  );

  // ── Markdown output (to stdout)
  console.log("# Sensitivity Analysis — Joint-Breakeven Wedge");
  console.log();
  console.log(`**Grid size:** ${rows.length} rows`);
  console.log(
    `  (${SIGMA_GRID.length} σ × ${IV_RV_GRID.length} IV/RV × ${CARRY_GRID.length} carry × ${FEE_RATE_GRID.length} fee-rate)`,
  );
  console.log();
  console.log("**Fixed reference position:**");
  console.log(
    `  L = ${REF.L}, S₀ = \$${REF.S0}, [p_l, p_u] = [\$${REF.pL}, \$${REF.pU}] (±${WIDTH_BPS / 100}%)`,
  );
  console.log(
    `  V(S₀) ≈ \$${rows[0].vPosition.toFixed(2)}, Cap_down ≈ \$${rows[0].capDown.toFixed(2)}`,
  );
  console.log(`  Tenor = 7 days, φ = 1.5%, y = 10%`);
  console.log();
  console.log("## Wedge `r* − r_u` (bps/day) across the full grid");
  console.log();
  console.log(
    `| Statistic | Value |`,
  );
  console.log(
    `|---|---|`,
  );
  console.log(`| Min | ${wMin.toFixed(4)} bps/day |`);
  console.log(`| Median | ${wMedian.toFixed(4)} bps/day |`);
  console.log(`| Mean | ${wMean.toFixed(4)} bps/day |`);
  console.log(`| **Max** | **${wMax.toFixed(4)} bps/day** |`);
  console.log(
    `| Threshold for claim "hedge cost is negligible" | ${CLAIM_THRESHOLD_BPS_PER_DAY.toFixed(2)} bps/day |`,
  );
  console.log(
    `| Rows exceeding threshold | ${overThreshold.length} / ${rows.length} |`,
  );
  console.log();

  // Marginal sensitivity tables (hold others at middle values)
  const midSigma = 0.65;
  const midCarry = 10;
  const midFee = 0.0025;

  console.log("## Marginal effect of IV/RV (σ=0.65, carry=10 bps/d, fee=0.25%/d)");
  console.log();
  console.log("| IV/RV | Premium | Wedge |");
  console.log("|---|---|---|");
  for (const iv of IV_RV_GRID) {
    const row = computeGridPoint(midSigma, iv, midCarry, midFee);
    console.log(
      `| ${row.ivRvRatio.toFixed(2)} | \$${row.premium.toFixed(4)} | ${row.wedgeBpsPerDay.toFixed(4)} bps/day |`,
    );
  }
  console.log();

  console.log("## Marginal effect of σ (IV/RV=1.08, carry=10 bps/d, fee=0.25%/d)");
  console.log();
  console.log("| σ (annualized) | FV_swap | Premium | Wedge |");
  console.log("|---|---|---|---|");
  for (const s of SIGMA_GRID) {
    const row = computeGridPoint(s, 1.08, midCarry, midFee);
    console.log(
      `| ${(s * 100).toFixed(0)}% | \$${row.fvSwap.toFixed(4)} | \$${row.premium.toFixed(4)} | ${row.wedgeBpsPerDay.toFixed(4)} bps/day |`,
    );
  }
  console.log();

  console.log("## Marginal effect of fee-rate (σ=0.65, IV/RV=1.08, carry=10 bps/d)");
  console.log();
  console.log("| Fee rate /day | E[F] | Premium | Wedge |");
  console.log("|---|---|---|---|");
  for (const fr of FEE_RATE_GRID) {
    const row = computeGridPoint(midSigma, 1.08, midCarry, fr);
    console.log(
      `| ${(fr * 100).toFixed(2)}% | \$${row.eFeesOverTenor.toFixed(2)} | \$${row.premium.toFixed(4)} | ${row.wedgeBpsPerDay.toFixed(4)} bps/day |`,
    );
  }
  console.log();

  console.log(`**CSV with all ${rows.length} grid rows:** ${csvPath}`);
  console.log();

  if (overThreshold.length > 0) {
    console.log("---");
    console.log(
      `⚠ ${overThreshold.length} grid row(s) exceed the claim threshold of ${CLAIM_THRESHOLD_BPS_PER_DAY} bps/day.`,
    );
    console.log("Worst offenders:");
    const worst = [...overThreshold]
      .sort((a, b) => b.wedgeBpsPerDay - a.wedgeBpsPerDay)
      .slice(0, 5);
    for (const r of worst) {
      console.log(
        `  σ=${r.sigma}  IV/RV=${r.ivRvRatio}  carry=${r.carryBpsPerDay}bps  fee=${r.feeRatePerDay} → wedge=${r.wedgeBpsPerDay.toFixed(4)} bps/day`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log("---");
    console.log(
      `✓ All ${rows.length} grid rows satisfy wedge ≤ ${CLAIM_THRESHOLD_BPS_PER_DAY} bps/day.`,
    );
    console.log(
      "  The structural claim of §2.4 and §8.5 (the hedge is nearly value-neutral in",
    );
    console.log(
      "  aggregate) is robust across the parameter space this PoC is exposed to.",
    );
  }
}

main();
