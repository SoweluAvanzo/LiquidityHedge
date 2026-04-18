/**
 * Template configurations for the Liquidity Hedge Protocol v3.
 *
 * v3 changes from v2:
 * - Single template: +/-7.5% width (dropped +/-5% based on simulation results
 *   showing RT is underwater at narrow ranges)
 * - barrierDepthBps MUST equal the position width: barrier = lower tick of the CL position.
 *   This ensures the corridor covers the ENTIRE in-range IL from entry to lower tick.
 *   For +/-7.5% width: barrierDepthBps = 750 (barrier at 92.5% of entry = lower tick).
 * - Wider floor/ceiling to accommodate cover ratio scaling
 *
 * Calibration: severity is auto-tuned at regime update time so the
 * on-chain heuristic tracks fair value at current realized sigma.
 * The effectiveMarkup (from IV/RV) is applied multiplicatively on top.
 */

import {
  TemplateConfig,
  PoolInitConfig,
  DEFAULT_FEE_SPLIT_RATE,
  DEFAULT_EXPECTED_DAILY_FEE,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_BARRIER_DEPTH_BPS,
} from "../types";

// ─── Default Severity ───────────────────────────────────────────────

/**
 * Starting-point severity value, calibrated at sigma = 65%, T = 7 days,
 * +/-7.5% width. Serves as the initial seed before the first dynamic
 * recalibration via updateRegime().
 *
 * At runtime, calibrateSeverity() in regime.ts re-derives this based
 * on realized sigma, so this is only a bootstrap default.
 */
export const DEFAULT_SEVERITY_PPM = 380_000;

// ─── Barrier Helper ──────────────────────────────────────────────────

/**
 * Compute barrier price from entry price and barrier depth.
 *
 * barrier = S0 * (1 - barrierDepthBps / BPS)
 *
 * Example: S0 = $150, barrierDepthBps = 750 (7.5%)
 *   barrier = $150 * 0.925 = $138.75
 *
 * @param entryPriceE6    Entry price in micro-USD (e.g. 150_000_000)
 * @param barrierDepthBps Barrier depth in basis points (e.g. 750 = 7.5%)
 * @returns Barrier price in micro-USD
 */
export function computeBarrierPrice(
  entryPriceE6: number,
  barrierDepthBps: number,
): number {
  return Math.floor(entryPriceE6 * (1 - barrierDepthBps / 10_000));
}

/** Default barrier depth percentage. */
export const DEFAULT_BARRIER_PCT = 1 - DEFAULT_BARRIER_DEPTH_BPS / 10_000; // 0.925

// ─── Template Definitions ────────────────────────────────────────────

/**
 * v3 template: single +/-7.5% width with configurable barrier depth.
 *
 * The +/-5% width was dropped because v2 simulation showed:
 * - RT is underwater at +/-5% (median +7% but mean -0.62%, MaxDD -81%)
 * - Plain LP dominates hedged LP at +/-5% when adjusting for fee yield
 * - The +/-7.5% width is the sweet spot: highest Sharpe (0.245), 86% P(+)
 *
 * barrierDepthBps defaults to 750 (7.5% below entry = lower tick), but can be
 * overridden per-template to create products with different risk profiles.
 */
export const V3_TEMPLATES: TemplateConfig[] = [
  {
    templateId: 1,
    tenorSeconds: 7 * 86_400,             // 7 days
    widthBps: 750,                          // +/-7.5%
    barrierDepthBps: DEFAULT_BARRIER_DEPTH_BPS, // 7.5% below entry (= lower tick)
    premiumFloorUsdc: 50_000,              // $0.05 minimum (micro-USDC)
    premiumCeilingUsdc: 500_000_000,       // $500 maximum (micro-USDC)
    active: true,
  },
];

// ─── Extended Template Info (for display / CLI) ──────────────────────

/** Human-readable template metadata. */
export const TEMPLATE_LABELS: Record<number, string> = {
  1: "standard-7.5pct",
};

/** Expected daily fee rate benchmarks (informational, not enforced). */
export const EXPECTED_DAILY_FEE_RATES: Record<number, number> = {
  1: 0.0055, // +/-7.5%: ~0.55%/day from Orca SOL/USDC whirlpool
};

// ─── Optimized Pool Configuration ────────────────────────────────────

/**
 * Default pool configuration for v3.
 *
 * Key changes from v2:
 * - No premiumMode or twoPartAlpha: premium is always FV * markup * coverRatio - feeDiscount
 * - feeSplitRate: 10% of LP's trading fees flow to RT pool at settlement
 * - expectedDailyFee: 0.5%/day expected fee rate for premium discount calculation
 * - markupFloor: 1.05x minimum effective markup (IV/RV can push higher)
 */
export const V3_POOL_DEFAULTS: Omit<PoolInitConfig, "admin" | "usdcMint" | "usdcVault"> = {
  uMaxBps: 3_000,                              // 30% max utilization
  feeSplitRate: DEFAULT_FEE_SPLIT_RATE,         // 0.10 (10%)
  expectedDailyFee: DEFAULT_EXPECTED_DAILY_FEE, // 0.005 (0.5%/day)
  markupFloor: DEFAULT_MARKUP_FLOOR,            // 1.05
  protocolFeeBps: 150,                          // 1.5% of premium to treasury
};

/**
 * Build a full PoolInitConfig by merging V3_POOL_DEFAULTS with
 * deployment-specific addresses.
 */
export function buildPoolInitConfig(
  admin: string,
  usdcMint: string,
  usdcVault: string,
  overrides?: Partial<PoolInitConfig>,
): PoolInitConfig {
  return {
    admin,
    usdcMint,
    usdcVault,
    ...V3_POOL_DEFAULTS,
    ...overrides,
  };
}
