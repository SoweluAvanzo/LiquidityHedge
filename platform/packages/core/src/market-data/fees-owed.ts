/**
 * Real uncollected fees for a concentrated-liquidity position.
 *
 * WHY THIS EXISTS. A Whirlpool position's `feeOwedA/B` fields are NOT the
 * fees it has earned — they are a CHECKPOINT, written only when the
 * position is touched (liquidity added or removed, or fees collected).
 * A position that has simply been sitting in range for a month reports
 * `feeOwedA = 0, feeOwedB = 0`, which is why the dashboard could show
 * "0 SOL + 0 USDC" on a position that has plainly earned fees.
 *
 * Everything accrued since that checkpoint lives in the pool and tick
 * accounts, and is reconstructed the way the program itself does it:
 *
 *   feeGrowthInside = feeGrowthGlobal − feeGrowthBelow − feeGrowthAbove
 *   uncollected     = feeOwed + L · (feeGrowthInside − checkpoint) / 2^64
 *
 * where "below"/"above" flip depending on which side of the range the
 * current tick sits — that flip is the whole trick, and getting it
 * backwards silently produces plausible-but-wrong numbers.
 *
 * ARITHMETIC. Every fee-growth quantity is u128 Q64.64 and is designed to
 * WRAP. Differences must therefore be taken mod 2^128, never as signed
 * subtraction: a wrapped accumulator would otherwise produce an enormous
 * positive delta and a nonsensical fee figure. `wrapSub` is the only way
 * these values are subtracted here.
 */

const U128 = 1n << 128n;
const Q64 = 1n << 64n;

/** Wrap-safe difference of two mod-2^128 accumulators. */
export function wrapSub(later: bigint, earlier: bigint): bigint {
  return (later - earlier + U128) % U128;
}

export interface FeeGrowthInsideParams {
  tickCurrentIndex: number;
  tickLowerIndex: number;
  tickUpperIndex: number;
  feeGrowthGlobalA: bigint;
  feeGrowthGlobalB: bigint;
  /** `fee_growth_outside_{a,b}` from the LOWER tick's account. */
  lowerOutsideA: bigint;
  lowerOutsideB: bigint;
  /** …and from the UPPER tick's account. */
  upperOutsideA: bigint;
  upperOutsideB: bigint;
}

/**
 * Fee growth accumulated INSIDE the range, per unit of liquidity.
 *
 * `fee_growth_outside` on a tick means "growth on the far side of this
 * tick, as seen from the current price". So its meaning flips as the price
 * crosses: below the lower tick, the lower tick's `outside` value is the
 * growth ABOVE it, hence the global-minus form.
 */
export function feeGrowthInside(p: FeeGrowthInsideParams): {
  insideA: bigint;
  insideB: bigint;
} {
  const below =
    p.tickCurrentIndex >= p.tickLowerIndex
      ? { a: p.lowerOutsideA, b: p.lowerOutsideB }
      : {
          a: wrapSub(p.feeGrowthGlobalA, p.lowerOutsideA),
          b: wrapSub(p.feeGrowthGlobalB, p.lowerOutsideB),
        };

  const above =
    p.tickCurrentIndex < p.tickUpperIndex
      ? { a: p.upperOutsideA, b: p.upperOutsideB }
      : {
          a: wrapSub(p.feeGrowthGlobalA, p.upperOutsideA),
          b: wrapSub(p.feeGrowthGlobalB, p.upperOutsideB),
        };

  return {
    insideA: wrapSub(wrapSub(p.feeGrowthGlobalA, below.a), above.a),
    insideB: wrapSub(wrapSub(p.feeGrowthGlobalB, below.b), above.b),
  };
}

export interface UncollectedFeesParams {
  liquidity: bigint;
  /** The position's checkpointed `fee_owed_{a,b}` (native units). */
  feeOwedA: bigint;
  feeOwedB: bigint;
  /** The position's `fee_growth_checkpoint_{a,b}` (Q64.64). */
  feeGrowthCheckpointA: bigint;
  feeGrowthCheckpointB: bigint;
  insideA: bigint;
  insideB: bigint;
}

/**
 * Total fees the position could collect right now, in native token units.
 *
 * This is the checkpoint PLUS everything earned since it was written, so
 * it is the figure a `collectFees` would actually pay out (the program
 * truncates the same way — integer division by 2^64).
 */
export function uncollectedFees(p: UncollectedFeesParams): {
  feesA: bigint;
  feesB: bigint;
} {
  const deltaA = wrapSub(p.insideA, p.feeGrowthCheckpointA);
  const deltaB = wrapSub(p.insideB, p.feeGrowthCheckpointB);
  return {
    feesA: p.feeOwedA + (p.liquidity * deltaA) / Q64,
    feesB: p.feeOwedB + (p.liquidity * deltaB) / Q64,
  };
}
