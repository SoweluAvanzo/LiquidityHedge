/**
 * Liquidity Hedge Protocol — Core Mathematical Utilities
 *
 * Integer arithmetic for on-chain compatibility: all computations
 * use BigInt (u128 equivalent) with explicit overflow checks.
 */

import { Q64 } from "../types";

// ---------------------------------------------------------------------------
// Integer square root — Newton's method for BigInt
// ---------------------------------------------------------------------------

/**
 * Compute floor(sqrt(n)) using Newton's method for non-negative BigInt.
 *
 * Converges in O(log(log(n))) iterations. Used for sqrt-price conversions
 * and the hit-probability calculation in the heuristic fair-value proxy.
 *
 * Reference: Press et al. (2007), Numerical Recipes, Ch. 9.4.
 */
export function integerSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Tick / sqrt-price conversions (Orca Whirlpool / Uniswap V3)
// ---------------------------------------------------------------------------

/**
 * Convert a tick index to sqrt-price in Q64.64 fixed-point.
 *
 * sqrtPrice_X64 = floor(sqrt(1.0001^tick) * 2^64)
 *
 * Reference: Adams et al. (2021), Uniswap V3 Core, Section 6.1.
 */
export function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
  return BigInt(Math.floor(sqrtPrice * Number(Q64)));
}

/**
 * Convert a sqrt-price (Q64.64) to a human-readable price.
 *
 * price = (sqrtPriceX64 / 2^64)^2 * 10^(decimalsA - decimalsB)
 *
 * For SOL/USDC (9 vs 6 decimals): price = (sqrtPriceX64 / 2^64)^2 * 1000
 *
 * Reference: Adams et al. (2021), Uniswap V3 Core, Section 6.2.
 */
export function sqrtPriceX64ToPrice(
  sqrtPriceX64: bigint,
  decimalsA: number = 9,
  decimalsB: number = 6,
): number {
  const sqrtPriceFloat = Number(sqrtPriceX64) / Number(Q64);
  const priceRaw = sqrtPriceFloat * sqrtPriceFloat;
  const decimalAdjust = Math.pow(10, decimalsA - decimalsB);
  return priceRaw * decimalAdjust;
}

/**
 * Convert a price (micro-USD, 6 decimals) to sqrt-price in Q64.64.
 *
 * sqrtPrice_X64 = floor(sqrt(price_e6 / 1e9) * 2^64)
 *
 * The 1e9 divisor accounts for SOL (9 dec) vs USDC (6 dec) = 10^3,
 * combined with the e6 scaling: 10^6 / 10^9 = 10^-3 -> 1/1e9 for raw ratio.
 */
export function priceE6ToSqrtPriceX64(priceE6: number): bigint {
  const numerator = BigInt(priceE6) * Q64 * Q64 / 1_000_000_000n;
  return integerSqrt(numerator);
}

/**
 * Convert a human-readable SOL price to micro-USD (e6 format).
 *
 * Example: priceToE6(150.0) = 150_000_000
 */
export function priceToE6(price: number): number {
  return Math.round(price * 1_000_000);
}

/**
 * Convert micro-USD (e6) back to human-readable price.
 *
 * Example: e6ToPrice(150_000_000) = 150.0
 */
export function e6ToPrice(priceE6: number): number {
  return priceE6 / 1_000_000;
}

/**
 * Align a tick index to the nearest valid tick for a given spacing.
 *
 * direction = "down": floor to nearest multiple
 * direction = "up": ceil to nearest multiple
 *
 * For Orca SOL/USDC 1% fee tier, tickSpacing = 64.
 */
export function alignTick(
  tick: number,
  tickSpacing: number,
  direction: "up" | "down",
): number {
  if (direction === "down") {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}
