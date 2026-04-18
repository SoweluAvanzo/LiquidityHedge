/**
 * Liquidity Hedge Protocol — Concentrated Liquidity Position Valuation
 *
 * Implements the three-regime CL position value function V(S) and
 * derived quantities: token amounts, USD valuation, natural cap.
 *
 * The CL value function is the mathematical foundation of the corridor
 * payoff. It is a piecewise function of the spot price S with three
 * regimes determined by the position's price bounds [p_l, p_u].
 *
 * References:
 *   Adams et al. (2021), "Uniswap v3 Core"
 *   Lambert et al. (2021), "Uniswap V3 LP Tokens as Perpetual Put and Call Options"
 */

import { Q64 } from "../types";

// ---------------------------------------------------------------------------
// Core CL value function V(S)
// ---------------------------------------------------------------------------

/**
 * Compute the value of a concentrated liquidity position at spot price S.
 *
 * V(S) is defined piecewise:
 *
 *   Below range (S <= p_l):
 *     V(S) = L * (1/sqrt(p_l) - 1/sqrt(p_u)) * S
 *     Position holds only token A (SOL). Value is linear in S.
 *
 *   In range (p_l < S < p_u):
 *     V(S) = L * (2*sqrt(S) - S/sqrt(p_u) - sqrt(p_l))
 *     Position holds a mix. Value is concave in S.
 *
 *   Above range (S >= p_u):
 *     V(S) = L * (sqrt(p_u) - sqrt(p_l))
 *     Position holds only token B (USDC). Value is constant.
 *
 * All values are in "token B units" (USDC). S, p_l, p_u must be in
 * the same denomination (e.g. USD per SOL).
 *
 * @param S   - Spot price (human-readable, e.g. 150.0)
 * @param L   - Liquidity parameter (real-valued)
 * @param pL  - Lower price bound (human-readable)
 * @param pU  - Upper price bound (human-readable)
 * @returns Position value in token B units (USD)
 */
export function clPositionValue(S: number, L: number, pL: number, pU: number): number {
  if (L === 0 || pL <= 0 || pU <= pL) return 0;

  const sqrtPL = Math.sqrt(pL);
  const sqrtPU = Math.sqrt(pU);

  if (S <= pL) {
    // Below range: all token A
    return L * (1 / sqrtPL - 1 / sqrtPU) * S;
  }
  if (S >= pU) {
    // Above range: all token B
    return L * (sqrtPU - sqrtPL);
  }
  // In range: mixed
  const sqrtS = Math.sqrt(S);
  return L * (2 * sqrtS - S / sqrtPU - sqrtPL);
}

// ---------------------------------------------------------------------------
// Token amounts from liquidity (Q64.64 fixed-point, on-chain compatible)
// ---------------------------------------------------------------------------

/**
 * Estimate token A and token B amounts for a CL position.
 *
 * Uses the Uniswap V3 / Orca Whirlpool formulas in Q64.64 fixed-point:
 *
 *   Below range: amount_A = L * (sqrtUpper - sqrtLower) * Q64 / (sqrtLower * sqrtUpper)
 *                amount_B = 0
 *
 *   Above range: amount_A = 0
 *                amount_B = L * (sqrtUpper - sqrtLower) / Q64
 *
 *   In range:    amount_A = L * (sqrtUpper - sqrtCurrent) * Q64 / (sqrtCurrent * sqrtUpper)
 *                amount_B = L * (sqrtCurrent - sqrtLower) / Q64
 *
 * @param liquidity    - Position liquidity L (bigint)
 * @param sqrtCurrent  - Current sqrt-price in Q64.64
 * @param sqrtLower    - Lower bound sqrt-price in Q64.64
 * @param sqrtUpper    - Upper bound sqrt-price in Q64.64
 * @returns [amountA, amountB] in native units (lamports, micro-USDC)
 */
export function estimateTokenAmounts(
  liquidity: bigint,
  sqrtCurrent: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
): { amountA: bigint; amountB: bigint } {
  if (liquidity === 0n) return { amountA: 0n, amountB: 0n };

  if (sqrtCurrent <= sqrtLower) {
    // Below range: all token A
    const amountA =
      (liquidity * (sqrtUpper - sqrtLower) * Q64) / sqrtLower / sqrtUpper;
    return { amountA, amountB: 0n };
  }
  if (sqrtCurrent >= sqrtUpper) {
    // Above range: all token B
    const amountB = (liquidity * (sqrtUpper - sqrtLower)) / Q64;
    return { amountA: 0n, amountB };
  }
  // In range
  const amountA =
    (liquidity * (sqrtUpper - sqrtCurrent) * Q64) / sqrtCurrent / sqrtUpper;
  const amountB = (liquidity * (sqrtCurrent - sqrtLower)) / Q64;
  return { amountA, amountB };
}

// ---------------------------------------------------------------------------
// USD valuation from token amounts
// ---------------------------------------------------------------------------

/**
 * Compute position value in USD from token amounts.
 *
 * value = (amountA_lamports * solPriceUsd) / 1e9 + amountB_microUsdc / 1e6
 *
 * @param amountA     - SOL amount in lamports (9 decimals)
 * @param amountB     - USDC amount in micro-USDC (6 decimals)
 * @param solPriceUsd - SOL price in USD (human-readable)
 * @returns Position value in USD (human-readable)
 */
export function positionValueUsd(
  amountA: bigint,
  amountB: bigint,
  solPriceUsd: number,
): number {
  const solAmount = Number(amountA) / 1e9;
  const usdcAmount = Number(amountB) / 1e6;
  return solAmount * solPriceUsd + usdcAmount;
}

/**
 * Compute position value in micro-USDC (e6) from token amounts.
 *
 * Used in on-chain settlement where all values are integer micro-USDC.
 *
 * value_e6 = (amountA * priceE6 / 1e9) + amountB
 *
 * @param amountA  - SOL in lamports
 * @param amountB  - USDC in micro-USDC
 * @param priceE6  - SOL price in micro-USD (6 decimals)
 * @returns Position value in micro-USDC
 */
export function positionValueE6(
  amountA: bigint,
  amountB: bigint,
  priceE6: number,
): number {
  const solValue = (Number(amountA) * priceE6) / 1_000_000_000;
  return Math.floor(solValue + Number(amountB));
}

// ---------------------------------------------------------------------------
// Natural cap: maximum corridor payout
// ---------------------------------------------------------------------------

/**
 * Compute the natural cap of a corridor certificate.
 *
 * naturalCap = V(S_0) - V(B)
 *
 * where B = p_l (the lower bound of the CL position range).
 * This is the maximum impermanent loss within the concentrated range.
 *
 * @param S0  - Entry price (human-readable)
 * @param L   - Liquidity parameter
 * @param pL  - Lower price bound = barrier price
 * @param pU  - Upper price bound
 * @returns Natural cap in token B units (USD)
 */
export function naturalCap(S0: number, L: number, pL: number, pU: number): number {
  const v0 = clPositionValue(S0, L, pL, pU);
  const vBarrier = clPositionValue(pL, L, pL, pU);
  return Math.max(0, v0 - vBarrier);
}

/**
 * Compute the natural cap in micro-USDC using integer arithmetic.
 *
 * @param entryPriceE6 - Entry price in micro-USD
 * @param liquidity    - Position liquidity (bigint)
 * @param sqrtLower    - Lower sqrt-price Q64.64
 * @param sqrtUpper    - Upper sqrt-price Q64.64
 * @returns Natural cap in micro-USDC
 */
export function naturalCapE6(
  entryPriceE6: number,
  liquidity: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
): number {
  const sqrtEntry = sqrtPriceFromE6(entryPriceE6);

  const entryAmounts = estimateTokenAmounts(liquidity, sqrtEntry, sqrtLower, sqrtUpper);
  const entryValue = positionValueE6(entryAmounts.amountA, entryAmounts.amountB, entryPriceE6);

  // At barrier (= p_l), sqrtCurrent = sqrtLower → all token A
  const barrierPriceE6 = sqrtPriceToE6(sqrtLower);
  const barrierAmounts = estimateTokenAmounts(liquidity, sqrtLower, sqrtLower, sqrtUpper);
  const barrierValue = positionValueE6(barrierAmounts.amountA, barrierAmounts.amountB, barrierPriceE6);

  return Math.max(0, entryValue - barrierValue);
}

// ---------------------------------------------------------------------------
// Liquidity estimation (reverse: amounts → L)
// ---------------------------------------------------------------------------

/**
 * Estimate liquidity L from token amounts and price range.
 *
 * @param amountA     - Token A in native units
 * @param amountB     - Token B in native units
 * @param sqrtCurrent - Current sqrt-price Q64.64
 * @param sqrtLower   - Lower sqrt-price Q64.64
 * @param sqrtUpper   - Upper sqrt-price Q64.64
 * @returns Estimated liquidity (bigint)
 */
export function estimateLiquidity(
  amountA: bigint,
  amountB: bigint,
  sqrtCurrent: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
): bigint {
  if (sqrtCurrent <= sqrtLower) {
    if (sqrtUpper <= sqrtLower) return 0n;
    return (amountA * sqrtLower * sqrtUpper) / Q64 / (sqrtUpper - sqrtLower);
  }
  if (sqrtCurrent >= sqrtUpper) {
    return (amountB * Q64) / (sqrtUpper - sqrtLower);
  }
  // In range: take min of L from each token
  const liqA =
    (amountA * sqrtCurrent * sqrtUpper) / Q64 / (sqrtUpper - sqrtCurrent);
  const liqB = (amountB * Q64) / (sqrtCurrent - sqrtLower);
  return liqA < liqB ? liqA : liqB;
}

// ---------------------------------------------------------------------------
// Corridor payoff Π(S_T)
// ---------------------------------------------------------------------------

/**
 * Compute the corridor payoff at settlement.
 *
 * Π(S_T) = min(Cap, max(0, V(S_0) - V(max(S_T, B))))
 *
 * where B = p_l (barrier equals lower range bound).
 *
 * Properties:
 *   - If S_T >= S_0: Π = 0 (no loss)
 *   - If B <= S_T < S_0: Π = V(S_0) - V(S_T), capped at Cap (partial loss)
 *   - If S_T < B: Π = Cap (barrier floors the effective price)
 *
 * @param settlementPrice - Settlement price (human-readable)
 * @param entryPrice      - Entry price S_0 (human-readable)
 * @param L               - Liquidity parameter
 * @param pL              - Lower bound = barrier
 * @param pU              - Upper bound
 * @param cap             - Natural cap (pre-computed)
 * @returns Payout in token B units (USD)
 */
export function corridorPayoff(
  settlementPrice: number,
  entryPrice: number,
  L: number,
  pL: number,
  pU: number,
  cap: number,
): number {
  if (settlementPrice >= entryPrice) return 0;

  const effectivePrice = Math.max(settlementPrice, pL);
  const entryValue = clPositionValue(entryPrice, L, pL, pU);
  const settleValue = clPositionValue(effectivePrice, L, pL, pU);
  const loss = Math.max(0, entryValue - settleValue);
  return Math.min(loss, cap);
}

// ---------------------------------------------------------------------------
// Helpers: sqrt-price ↔ e6 price
// ---------------------------------------------------------------------------

/**
 * Approximate sqrt-price (Q64.64) from a price in micro-USD (e6).
 * For SOL/USDC: accounts for 9 vs 6 decimal difference.
 */
function sqrtPriceFromE6(priceE6: number): bigint {
  // price_raw = priceE6 / 1e9 (adjusting for decimal difference)
  // sqrtPrice_X64 = sqrt(price_raw) * 2^64
  const numerator = BigInt(priceE6) * Q64 * Q64 / 1_000_000_000n;
  return bigintSqrt(numerator);
}

/**
 * Convert sqrt-price (Q64.64) back to micro-USD (e6).
 */
function sqrtPriceToE6(sqrtPriceX64: bigint): number {
  const sqrtFloat = Number(sqrtPriceX64) / Number(Q64);
  const priceRaw = sqrtFloat * sqrtFloat;
  return Math.floor(priceRaw * 1_000_000_000);
}

/** Integer square root for bigint (Newton's method) */
function bigintSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
