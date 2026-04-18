/**
 * Optimized template configurations derived from Monte Carlo simulation study.
 *
 * Calibration method: for each position width, severity_ppm was tuned so that
 * the on-chain heuristic premium ≈ 1.20× the Gauss-Hermite no-arbitrage fair
 * value at σ=65%, T=7 days, barrier=90%, r=0.
 *
 * See: analysis/parameter_optimization.ipynb, analysis/simulation_report.md
 */

/** Calibrated severity values (one-time computation) */
export const CALIBRATED_SEVERITY = {
  "5pct": 345_000,   // ±5% width → 1.200× fair value at σ=65%
  "10pct": 420_000,  // ±10% width → 1.200× fair value
  "15pct": 640_000,  // ±15% width → 1.196× fair value
} as const;

/** Optimized pool parameters */
export const OPTIMIZED_POOL = {
  uMaxBps: 3_000,                // 30% max utilization (balances RT income vs crash risk)
  premiumUpfrontBps: 10_000,     // 100% upfront (v1)
  feeShareMinBps: 2_000,         // 20% minimum fee share (LP premium offset)
  feeShareMaxBps: 3_000,         // 30% maximum fee share
  earlyExitPenaltyBps: 200,      // 2% early withdrawal penalty
  rtTickWidthMultiplier: 2,      // RT position = 2× LP width
  protocolFeeBps: 150,           // 1.5% of premium to protocol treasury
} as const;

/**
 * Barrier = lower tick of the position range.
 * This means the corridor covers the ENTIRE in-range loss.
 * barrier_pct = 1 - width_pct, so barrier equals the lower tick price.
 */
export function barrierPctForWidth(widthBps: number): number {
  return 1 - widthBps / 10_000;
}

/** Default barrier for ±10% (backward compat) */
export const DEFAULT_BARRIER_PCT = 0.90;

/** Template definitions for each supported position width */
export const OPTIMIZED_TEMPLATES = [
  {
    templateId: 1,
    label: "narrow-5pct",
    tenorSeconds: 7 * 86_400,        // 7 days
    widthBps: 500,                    // ±5%
    barrierPct: 0.95,                 // = 1 - 0.05 → barrier = lower tick
    severityPpm: CALIBRATED_SEVERITY["5pct"],
    premiumFloorUsdc: 50_000,         // $0.05 minimum (micro-USDC)
    premiumCeilingUsdc: 500_000_000,  // $500 maximum (micro-USDC)
    feeShareBps: 2_500,              // 25% of LP fees offset premium
    expectedDailyFeeRate: 0.0065,    // 0.65%/day (reference, not enforced)
  },
  {
    templateId: 2,
    label: "medium-10pct",
    tenorSeconds: 7 * 86_400,
    widthBps: 1_000,                  // ±10%
    barrierPct: 0.90,                 // = 1 - 0.10 → barrier = lower tick
    severityPpm: CALIBRATED_SEVERITY["10pct"],
    premiumFloorUsdc: 50_000,
    premiumCeilingUsdc: 500_000_000,
    feeShareBps: 2_000,              // 20%
    expectedDailyFeeRate: 0.0034,
  },
  {
    templateId: 3,
    label: "wide-15pct",
    tenorSeconds: 7 * 86_400,
    widthBps: 1_500,                  // ±15%
    barrierPct: 0.85,                 // = 1 - 0.15 → barrier = lower tick
    severityPpm: CALIBRATED_SEVERITY["15pct"],
    premiumFloorUsdc: 50_000,
    premiumCeilingUsdc: 500_000_000,
    feeShareBps: 3_000,              // 30%
    expectedDailyFeeRate: 0.0023,
  },
] as const;
