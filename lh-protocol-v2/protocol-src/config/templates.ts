/**
 * Optimized template configurations for the Liquidity Hedge Protocol v2.
 *
 * v2 changes vs v1:
 * - severityPpm is NO LONGER in templates — it is dynamically calibrated
 *   in RegimeSnapshot so the heuristic premium tracks fair value under
 *   changing volatility regimes.
 * - Only 2 templates remain: +/-5% (narrow) and +/-10% (medium).
 *   The +/-15% width was dropped because simulation showed poor LP
 *   utilization at wide ranges on SOL/USDC.
 * - Markup reduced from 1.20x to 1.10x.
 * - Pool defaults to two-part premium mode with alpha = 0.40.
 *
 * Calibration method: for each position width, severity_ppm is auto-tuned
 * at regime update time so that the on-chain heuristic premium ~ 1.10x
 * the Gauss-Hermite no-arbitrage fair value at current realized sigma.
 *
 * See: analysis/parameter_optimization.ipynb, analysis/simulation_report.md
 */

import { TemplateConfig, PoolInitConfig, DEFAULT_MARKUP, DEFAULT_ALPHA, DEFAULT_MARKUP_FLOOR } from "../types";

// ─── Default Regime Severity ─────────────────────────────────────────

/**
 * Starting-point severity values for each supported width, calibrated
 * at sigma = 65%, T = 7 days. These serve as initial seeds before the
 * first dynamic recalibration via updateRegime().
 *
 * Key: widthBps, Value: severityPpm
 *
 * At runtime, calibrateSeverity() in regime.ts will re-derive these
 * based on realized sigma, so these are only bootstrap defaults.
 */
export const DEFAULT_REGIME_SEVERITY: Record<number, number> = {
  500:  310_000,   // +/-5% width  ~ 1.10x fair value at sigma=65%
  1000: 380_000,   // +/-10% width ~ 1.10x fair value at sigma=65%
};

// ─── Barrier Helper ──────────────────────────────────────────────────

/**
 * Barrier = lower tick of the position range.
 * This means the corridor covers the ENTIRE in-range loss.
 * barrier_pct = 1 - width_pct, so barrier equals the lower tick price.
 */
export function barrierPctForWidth(widthBps: number): number {
  return 1 - widthBps / 10_000;
}

/** Default barrier for +/-10% (backward compat) */
export const DEFAULT_BARRIER_PCT = 0.90;

// ─── Template Definitions ────────────────────────────────────────────

/**
 * v2 template definitions.
 * Note: severityPpm is NOT here — it lives in RegimeSnapshot and is
 * dynamically recalibrated by the regime update service.
 */
export const OPTIMIZED_TEMPLATES: TemplateConfig[] = [
  {
    templateId: 1,
    tenorSeconds: 7 * 86_400,          // 7 days
    widthBps: 500,                      // +/-5%
    premiumFloorUsdc: 50_000,           // $0.05 minimum (micro-USDC)
    premiumCeilingUsdc: 500_000_000,    // $500 maximum (micro-USDC)
    active: true,
  },
  {
    templateId: 2,
    tenorSeconds: 7 * 86_400,          // 7 days
    widthBps: 1_000,                    // +/-10%
    premiumFloorUsdc: 50_000,
    premiumCeilingUsdc: 500_000_000,
    active: true,
  },
];

// ─── Extended Template Info (for display / CLI) ──────────────────────

/** Human-readable template metadata for CLI and API display. */
export const TEMPLATE_LABELS: Record<number, string> = {
  1: "narrow-5pct",
  2: "medium-10pct",
};

/** Expected daily fee rate benchmarks (informational, not enforced). */
export const EXPECTED_DAILY_FEE_RATES: Record<number, number> = {
  1: 0.0065,   // +/-5%: ~0.65%/day
  2: 0.0034,   // +/-10%: ~0.34%/day
};

// ─── Optimized Pool Configuration ────────────────────────────────────

/**
 * Default pool configuration for v2.
 *
 * Key change: premiumMode = 'two-part' with alpha = 0.40.
 * This means 40% of the heuristic premium is paid upfront, and the
 * remaining premium is deferred to settlement as beta * actualFeesAccrued.
 */
export const OPTIMIZED_POOL: Omit<PoolInitConfig, "admin" | "usdcMint" | "usdcVault"> = {
  uMaxBps: 3_000,             // 30% max utilization
  premiumMode: "two-part",
  twoPartAlpha: DEFAULT_ALPHA, // 0.40
  protocolFeeBps: 150,         // 1.5% of premium to protocol treasury
  markupFloor: DEFAULT_MARKUP_FLOOR, // 1.05x minimum effective markup
};

/**
 * Build a full PoolInitConfig by merging OPTIMIZED_POOL defaults with
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
    ...OPTIMIZED_POOL,
    ...overrides,
  };
}
