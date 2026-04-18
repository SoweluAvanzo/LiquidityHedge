/**
 * Liquidity Hedge Protocol — Template & Pool Configuration
 *
 * Defines the default product template (+/-10% width, 7-day tenor)
 * and pool governance defaults. The barrier is always derived from
 * the template width: B = S_0 * (1 - widthBps / BPS).
 */

import {
  BPS,
  DEFAULT_EXPECTED_DAILY_FEE,
  DEFAULT_FEE_SPLIT_RATE,
  DEFAULT_MARKUP_FLOOR,
  DEFAULT_PREMIUM_FLOOR_USDC,
  DEFAULT_PROTOCOL_FEE_BPS,
  DEFAULT_SEVERITY_PPM,
  DEFAULT_U_MAX_BPS,
  TemplateConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Pool governance defaults
// ---------------------------------------------------------------------------

export interface PoolInitConfig {
  /** Maximum utilization ratio (BPS) */
  uMaxBps: number;
  /** Minimum volatility markup */
  markupFloor: number;
  /** Fee-split rate y */
  feeSplitRate: number;
  /** Expected daily LP fee rate */
  expectedDailyFee: number;
  /** Premium floor P_floor (micro-USDC) — governance parameter */
  premiumFloorUsdc: number;
  /** Protocol treasury fee (BPS) */
  protocolFeeBps: number;
}

export const DEFAULT_POOL_CONFIG: PoolInitConfig = {
  uMaxBps: DEFAULT_U_MAX_BPS,           // 30% max utilization
  markupFloor: DEFAULT_MARKUP_FLOOR,     // 1.05 minimum markup
  feeSplitRate: DEFAULT_FEE_SPLIT_RATE,  // 10% of LP fees to RT
  expectedDailyFee: DEFAULT_EXPECTED_DAILY_FEE, // 0.5%/day
  premiumFloorUsdc: DEFAULT_PREMIUM_FLOOR_USDC, // $0.05
  protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,     // 1.5%
};

// ---------------------------------------------------------------------------
// Product template: +/-10% corridor, 7-day tenor
// ---------------------------------------------------------------------------

/**
 * The single product template for the final protocol version.
 *
 * Width: +/-10% (widthBps = 1000)
 *   - The LP opens a CL position from p_l = S_0*0.90 to p_u = S_0*1.10
 *   - The barrier equals p_l = S_0 * 0.90
 *   - The corridor covers the full concentrated liquidity range
 *
 * Tenor: 7 days (604800 seconds)
 *   - Weekly rolling hedge, renewable at expiry
 *
 * Rationale for +/-10% (from v2/v3 backtesting):
 *   - Highest Sharpe ratio (0.245) across tested widths
 *   - Highest probability of positive RT return (86%)
 *   - +/-5% is RT-insolvent (negative mean return, -81% max drawdown)
 *   - +/-15% requires premium > expected fee income (beta > 1.0)
 */
export const DEFAULT_TEMPLATE: TemplateConfig = {
  templateId: 1,
  widthBps: 1_000,                      // +/-10%
  tenorSeconds: 7 * 86_400,             // 7 days
  premiumCeilingUsdc: 500_000_000,       // $500 safety ceiling
  expectedDailyFeeBps: 45,               // 0.45%/day for +/-10% range
};

/**
 * Default bootstrap severity for the heuristic fair-value proxy.
 *
 * Calibrated so that at sigma=65% (annualized), T=7d, width=+/-10%,
 * the heuristic approximates the Gauss-Hermite quadrature FV within ~10%.
 *
 * This value is updated dynamically by the regime service via
 * calibrateSeverity() once real volatility data is available.
 */
export const BOOTSTRAP_SEVERITY_PPM = DEFAULT_SEVERITY_PPM; // 380,000

// ---------------------------------------------------------------------------
// Barrier computation
// ---------------------------------------------------------------------------

/**
 * Compute barrier price from entry price and position width.
 *
 * barrier = S_0 * (1 - widthBps / BPS)
 *
 * The barrier always coincides with the lower bound of the LP's
 * concentrated liquidity position range. This is a core design choice:
 * the corridor certificate hedges exactly the IL within the CL range.
 *
 * Example:
 *   S_0 = $150.00 (150_000_000 in e6)
 *   widthBps = 1000 (+/-10%)
 *   barrier = 150_000_000 * (1 - 1000/10000) = 135_000_000 ($135.00)
 *
 * @param entryPriceE6 - Entry price in micro-USD (6 decimals)
 * @param widthBps     - Position width in BPS (e.g. 1000 = +/-10%)
 * @returns Barrier price in micro-USD
 */
export function computeBarrierFromWidth(
  entryPriceE6: number,
  widthBps: number,
): number {
  return Math.floor(entryPriceE6 * (1 - widthBps / BPS));
}

/**
 * Compute the upper price bound from entry price and width.
 *
 * p_u = S_0 * (1 + widthBps / BPS)
 *
 * @param entryPriceE6 - Entry price in micro-USD
 * @param widthBps     - Position width in BPS
 * @returns Upper bound price in micro-USD
 */
export function computeUpperBound(
  entryPriceE6: number,
  widthBps: number,
): number {
  return Math.floor(entryPriceE6 * (1 + widthBps / BPS));
}
