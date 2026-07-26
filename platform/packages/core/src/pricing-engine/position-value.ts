/**
 * Liquidity Hedge Protocol — Concentrated Liquidity Position Valuation
 *
 * Implements the three-regime CL position value function V(S) and
 * derived quantities: token amounts, USD valuation, natural cap.
 *
 * The CL value function is the mathematical foundation of the Liquidity Hedge
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
// Natural caps: maximum RT and LP liabilities under the Liquidity Hedge swap
// ---------------------------------------------------------------------------

/**
 * Compute the downside cap of the Liquidity Hedge (maximum RT liability).
 *
 *   Cap_down = V(S_0) - V(p_l)
 *
 * Reached when the settlement price falls to or below the lower bound.
 * This is the maximum USDC the RT pool can owe the LP for a single
 * certificate, and is therefore the quantity the pool underwrites.
 *
 * @param S0  - Entry price (human-readable)
 * @param L   - Liquidity parameter
 * @param pL  - Lower price bound
 * @param pU  - Upper price bound
 * @returns Downside cap in token B units (USD)
 */
export function naturalCap(S0: number, L: number, pL: number, pU: number): number {
  const v0 = clPositionValue(S0, L, pL, pU);
  const vLower = clPositionValue(pL, L, pL, pU);
  return Math.max(0, v0 - vLower);
}

/**
 * Compute the upside cap of the Liquidity Hedge (maximum LP give-up).
 *
 *   Cap_up = V(p_u) - V(S_0)
 *
 * Reached when the settlement price rises to or above the upper bound.
 * At that point the LP's position is fully token B (USDC) worth V(p_u),
 * and the LP surrenders V(p_u) - V(S_0) to the RT out of those proceeds.
 *
 * By concavity of V on [p_l, p_u], Cap_up < Cap_down for symmetric
 * widths — the upside give-up is strictly smaller than the downside
 * protection, which is precisely the convexity adjustment priced into
 * the hedge.
 *
 * @param S0  - Entry price (human-readable)
 * @param L   - Liquidity parameter
 * @param pL  - Lower price bound
 * @param pU  - Upper price bound
 * @returns Upside cap in token B units (USD), always >= 0
 */
export function naturalCapUp(S0: number, L: number, pL: number, pU: number): number {
  const v0 = clPositionValue(S0, L, pL, pU);
  const vUpper = clPositionValue(pU, L, pL, pU);
  return Math.max(0, vUpper - v0);
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
// Liquidity Hedge payoff Π(S_T) — signed swap on V(·)
// ---------------------------------------------------------------------------

/**
 * Compute the Liquidity Hedge payoff at settlement.
 *
 *   Π(S_T) = V(S_0) - V(clamp(S_T, p_l, p_u))
 *
 * This is a signed swap on the CL value function V(·): the LP exchanges
 * their position's value variability for a locked-in V(S_0) over the
 * active range [p_l, p_u]. Positive payoff ⇒ RT owes the LP; negative
 * payoff ⇒ LP owes the RT (settled physically from the escrowed
 * position's proceeds, which always cover the owed amount).
 *
 * Piecewise:
 *   - S_T < p_l:            Π = V(S_0) - V(p_l) = +Cap_down  (RT pays max)
 *   - p_l <= S_T <= p_u:    Π = V(S_0) - V(S_T)              (exact IL replication)
 *   - S_T > p_u:            Π = V(S_0) - V(p_u) = -Cap_up    (LP pays max)
 *
 * Bounds: -Cap_up <= Π(S_T) <= Cap_down for all S_T > 0.
 * Monotonicity: Π is non-increasing in S_T.
 * Sign: Π >= 0 iff S_T <= S_0.
 *
 * @param settlementPrice - Settlement price (human-readable)
 * @param entryPrice      - Entry price S_0 (human-readable)
 * @param L               - Liquidity parameter
 * @param pL              - Lower price bound
 * @param pU              - Upper price bound
 * @returns Signed payoff in token B units (USD)
 */
export function lhPayoff(
  settlementPrice: number,
  entryPrice: number,
  L: number,
  pL: number,
  pU: number,
): number {
  const clampedST = Math.max(pL, Math.min(pU, settlementPrice));
  const entryValue = clPositionValue(entryPrice, L, pL, pU);
  const settleValue = clPositionValue(clampedST, L, pL, pU);
  return entryValue - settleValue;
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
