/**
 * Position-level realised fee yield (remediation plan §1.2).
 *
 * The pool-level chain multiplies three estimates — r_pool × in-range
 * fraction × concentration factor — each carrying its own error. A
 * position's OWN accumulator makes all three unnecessary:
 *
 *   fees(t₀ → t₁) = L_pos × (feeGrowthInside(t₁) − feeGrowthInside(t₀)) / 2⁶⁴
 *
 * is EXACTLY what the position earned over the window — in range or not,
 * concentration and occupancy already inside it, protocol fee already
 * excluded by the program. `feeGrowthInside` snapshots are captured by
 * the collector (and opportunistically by the dashboard) from the pool +
 * tick accounts, the same reconstruction `collectFees` itself uses.
 *
 * ARITHMETIC. Inside-growth values are u128 Q64.64 and wrap; deltas are
 * taken mod 2^128 like every other fee-growth quantity. A wrapped or
 * inconsistent accumulator (tick re-initialisation, decode error) shows
 * up as an astronomically large delta and is REJECTED per interval,
 * never included.
 */

const Q64 = 1n << 64n;
const U128 = 1n << 128n;

/** Wrap-safe delta in mod-2^128 arithmetic. */
function wrapDelta(later: bigint, earlier: bigint): bigint {
  return (later - earlier + U128) % U128;
}

/** One reading of a position's fee accumulator (see schema.sql). */
export interface PositionFeeSnapshot {
  /** Unix seconds at capture. */
  t: number;
  whirlpool: string;
  /** Position liquidity at capture (u128, stringified). */
  liquidity: string;
  /** feeGrowthInside for the position's range, token A (Q64.64 u128). */
  feeGrowthInsideA: string;
  /** Same for token B. */
  feeGrowthInsideB: string;
  /** Human pool price (token B per token A) at capture. */
  price: number;
  /** Whether the pool's current tick was inside the range at capture. */
  inRange: boolean;
}

export interface MeasuredPositionFees {
  /** Fees earned over covered intervals, quote units (USD for USDC pools). */
  feesQuote: number;
  /** Fees per token, native units — for cross-checks against the chain. */
  feesA: bigint;
  feesB: bigint;
  /** Seconds actually integrated. */
  coveredSeconds: number;
  /** Wall-clock span from first to last snapshot considered. */
  windowSeconds: number;
  intervals: number;
  /** Intervals skipped: longer than maxGapSeconds. */
  gapIntervals: number;
  /** Intervals skipped: position liquidity changed inside the interval,
   *  making the Δinside × L attribution ambiguous. */
  liquidityChangeIntervals: number;
  /** Intervals skipped: wrapped/reset accumulator. */
  implausibleIntervals: number;
  /** Covered seconds spent in range (crossing intervals weighted ½). */
  inRangeSeconds: number;
  firstT: number;
  lastT: number;
}

/** Absolute per-interval ceiling — the last-resort default when the
 *  caller cannot supply a position-relative one. NOTE: the fee-reader's
 *  $1M ceiling bounds a whole-certificate CUMULATIVE figure; bounding a
 *  15-minute increment with it is toothless for small positions, so
 *  callers that know the position value MUST pass
 *  `implausibleIntervalFeesQuote` (e.g. 0.5 × position value — real fees
 *  cannot reach 50% of position value between snapshots). */
const IMPLAUSIBLE_INTERVAL_FEES_QUOTE = 1_000_000;

/**
 * Realised position fees over a snapshot window. Returns null when not a
 * single interval is usable — the caller falls back to the modelled
 * chain and labels it.
 */
export function measurePositionFees(
  snapshots: PositionFeeSnapshot[],
  decimalsA: number,
  decimalsB: number,
  opts?: {
    maxGapSeconds?: number;
    /** Position-relative per-interval ceiling, quote units. */
    implausibleIntervalFeesQuote?: number;
  },
): MeasuredPositionFees | null {
  if (snapshots.length < 2) return null;
  const maxGap = opts?.maxGapSeconds ?? 3600;
  const feeCeiling =
    opts?.implausibleIntervalFeesQuote ?? IMPLAUSIBLE_INTERVAL_FEES_QUOTE;

  let feesQuote = 0;
  let feesA = 0n;
  let feesB = 0n;
  let covered = 0;
  let inRangeSeconds = 0;
  let intervals = 0;
  let gapIntervals = 0;
  let liquidityChangeIntervals = 0;
  let implausibleIntervals = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1];
    const b = snapshots[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    if (dt > maxGap) {
      gapIntervals++;
      continue;
    }
    const L = BigInt(a.liquidity);
    if (L !== BigInt(b.liquidity)) {
      liquidityChangeIntervals++;
      continue;
    }

    const dA = wrapDelta(BigInt(b.feeGrowthInsideA), BigInt(a.feeGrowthInsideA));
    const dB = wrapDelta(BigInt(b.feeGrowthInsideB), BigInt(a.feeGrowthInsideB));
    const rawA = (dA * L) / Q64;
    const rawB = (dB * L) / Q64;
    const priceMid = (a.price + b.price) / 2;
    const fees =
      (Number(rawA) / 10 ** decimalsA) * priceMid + Number(rawB) / 10 ** decimalsB;

    if (!Number.isFinite(fees) || fees < 0 || fees > feeCeiling) {
      implausibleIntervals++;
      continue;
    }

    feesQuote += fees;
    feesA += rawA;
    feesB += rawB;
    covered += dt;
    if (a.inRange && b.inRange) inRangeSeconds += dt;
    else if (a.inRange !== b.inRange) inRangeSeconds += dt / 2;
    intervals++;
  }

  if (intervals === 0 || covered <= 0) return null;
  return {
    feesQuote,
    feesA,
    feesB,
    coveredSeconds: covered,
    windowSeconds: snapshots[snapshots.length - 1].t - snapshots[0].t,
    intervals,
    gapIntervals,
    liquidityChangeIntervals,
    implausibleIntervals,
    inRangeSeconds,
    firstT: snapshots[0].t,
    lastT: snapshots[snapshots.length - 1].t,
  };
}
