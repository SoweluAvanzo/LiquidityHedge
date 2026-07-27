/**
 * Realised position-level fee yield (§1.2, revised after the 2026-07-27
 * estimator audits).
 *
 * What is measured: the position's own accumulator, `L × Δ
 * feeGrowthInside / 2⁶⁴` over the trailing snapshot window — restricted
 * to the suffix of history at the position's CURRENT liquidity, so fees
 * earned by a different-sized position never enter the ratio.
 *
 * What is served: the realised IN-RANGE fee intensity,
 *
 *   r_in = feesQuote / inRangeSeconds-as-days / positionValue
 *
 * i.e. what the position earns per day per dollar WHILE in range —
 * concentration and fee competition measured, occupancy deliberately
 * EXCLUDED. The viability layer multiplies by the forward in-range
 * estimate, because E[F] and both viability indices are forward
 * quantities; substituting a trailing occupancy for a forward one was
 * the audit's top semantic finding (a position that left its range
 * three days ago would otherwise keep half its historic yield for the
 * whole trailing window).
 *
 * Failure policy: anything short of a fresh, sufficient, current-L,
 * in-range-bearing window returns { ok:false, reason } and the caller
 * falls back to the §1.1 modelled chain, LABELLED as such.
 */

import type { PortfolioPositionView } from "@lh/portfolio";
import { measurePositionFees, type MeasuredPositionFees } from "@lh/market-data";
import {
  PgPositionFeeStore,
  PgTrackedPositionStore,
  numericEnv,
  type TrackedPositionRow,
} from "@lh/storage";
import { getDbPool } from "./db";
import { SOL_MINT } from "./birdeye";

/** Trailing lookback over which position snapshots are read. */
const LOOKBACK_SECONDS = numericEnv("POSITION_YIELD_LOOKBACK_SECONDS", 7 * 86_400);
/** Minimum integrated coverage before the realised figure is served. */
const MIN_COVERED_SECONDS = numericEnv(
  "POSITION_YIELD_MIN_COVERED_SECONDS",
  6 * 3_600,
);
/** Collector cadence is 900s; longer intervals are collector outages. */
const MAX_GAP_SECONDS = numericEnv("POSITION_YIELD_MAX_GAP_SECONDS", 3_600);
/** Maximum age of the window's END — a dead collector must not keep
 *  serving days-old data as "realised". */
const MAX_WINDOW_AGE_SECONDS = numericEnv("POSITION_YIELD_MAX_AGE_SECONDS", 3_600);
/** Minimum in-range time before an in-range INTENSITY is a measurement
 *  rather than one noisy crossing interval. */
const MIN_IN_RANGE_SECONDS = numericEnv(
  "POSITION_YIELD_MIN_IN_RANGE_SECONDS",
  1_800,
);
/** Registration cap per request — the portfolio API is public. */
const MAX_REGISTER_PER_REQUEST = numericEnv("POSITION_TRACK_MAX_PER_REQUEST", 20);
/** Minimum spacing between opportunistic snapshot appends per position. */
const MIN_APPEND_SPACING_SECONDS = numericEnv(
  "POSITION_SNAPSHOT_MIN_SPACING_SECONDS",
  300,
);

export type RealisedPositionYieldResult =
  | {
      ok: true;
      /** Realised IN-RANGE daily fee intensity on current value —
       *  multiply by a FORWARD occupancy estimate before comparing to
       *  any forward quantity. */
      inRangeDailyRate: number;
      measured: MeasuredPositionFees;
    }
  | { ok: false; reason: string };

export async function readRealisedPositionYield(
  view: PortfolioPositionView,
): Promise<RealisedPositionYieldResult> {
  if (!view.isUsdcQuoted) {
    return { ok: false, reason: "position is not USDC-quoted" };
  }
  if (!(view.valueQuote > 0)) {
    return { ok: false, reason: "position has no current value to yield against" };
  }
  const db = getDbPool();
  if (!db) {
    return { ok: false, reason: "no DATABASE_URL configured (snapshot history unavailable)" };
  }
  try {
    const store = new PgPositionFeeStore(db);
    const now = Math.floor(Date.now() / 1000);
    const all = await store.read(view.positionAddress, now - LOOKBACK_SECONDS, now);

    // Only the suffix at the CURRENT liquidity: fees earned by a
    // different-sized position divided by today's value would be a
    // ratio of two different positions (audit F3 — the dust-withdrawal
    // case turns it into a green badge on a husk).
    const currentL = view.liquidity.toString();
    let start = all.length;
    while (start > 0 && all[start - 1].liquidity === currentL) start--;
    const snapshots = all.slice(start);

    if (snapshots.length < 2) {
      return {
        ok: false,
        reason:
          all.length >= 2
            ? `position liquidity changed recently (${snapshots.length} snapshot(s) at current liquidity)`
            : `position history too short (${all.length} snapshot(s) in the last ${Math.round(LOOKBACK_SECONDS / 3600)}h)`,
      };
    }
    const measured = measurePositionFees(
      snapshots,
      view.decimalsA,
      view.decimalsB,
      {
        maxGapSeconds: MAX_GAP_SECONDS,
        // Real fees cannot reach 50% of position value between two
        // snapshots; anything above is a corrupted accumulator. The $1M
        // library default is meaningless for a small position.
        implausibleIntervalFeesQuote: Math.max(1, 0.5 * view.valueQuote),
      },
    );
    if (!measured) {
      return { ok: false, reason: "no usable snapshot interval for this position" };
    }
    if (measured.coveredSeconds < MIN_COVERED_SECONDS) {
      return {
        ok: false,
        reason: `position coverage ${(measured.coveredSeconds / 3600).toFixed(1)}h below the ${Math.round(MIN_COVERED_SECONDS / 3600)}h minimum`,
      };
    }
    if (now - measured.lastT > MAX_WINDOW_AGE_SECONDS) {
      return {
        ok: false,
        reason: `position snapshot window stale (ended ${((now - measured.lastT) / 3600).toFixed(1)}h ago — collector down?)`,
      };
    }
    if (measured.inRangeSeconds < MIN_IN_RANGE_SECONDS) {
      return {
        ok: false,
        reason: `only ${(measured.inRangeSeconds / 60).toFixed(0)}min in range over the ${(measured.coveredSeconds / 3600).toFixed(1)}h window — no realised in-range rate measurable`,
      };
    }
    return {
      ok: true,
      inRangeDailyRate:
        measured.feesQuote / view.valueQuote / (measured.inRangeSeconds / 86_400),
      measured,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[position-yield] snapshot read failed for ${view.positionAddress}: ${msg}`,
    );
    return { ok: false, reason: "position snapshot store unavailable" };
  }
}

/**
 * Register served positions for collector tracking and persist their
 * just-computed feeGrowthInside as an opportunistic snapshot. Hardened
 * per the audit: hedge-eligible (SOL/USDC) positions only, capped per
 * request, and appends are spaced ≥ MIN_APPEND_SPACING_SECONDS per
 * position so a curl loop cannot flood the table. Best-effort: a DB
 * hiccup must never break the portfolio response.
 */
export async function recordPositionObservations(
  views: PortfolioPositionView[],
): Promise<void> {
  const db = getDbPool();
  if (!db) return;
  const eligible = views
    .filter(
      (v) =>
        v.tokenMintA === SOL_MINT &&
        v.isUsdcQuoted &&
        v.feeGrowthInsideA !== undefined &&
        v.feeGrowthInsideB !== undefined,
    )
    .slice(0, MAX_REGISTER_PER_REQUEST);
  if (eligible.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    const tracked: TrackedPositionRow[] = eligible.map((v) => ({
      position: v.positionAddress,
      positionMint: v.positionMint,
      whirlpool: v.whirlpool,
      decimalsA: v.decimalsA,
      decimalsB: v.decimalsB,
    }));
    await new PgTrackedPositionStore(db).touch(tracked, now);

    const feeStore = new PgPositionFeeStore(db);
    const latest = await feeStore.latestTimes(eligible.map((v) => v.positionAddress));
    const due = eligible.filter((v) => {
      const t = latest.get(v.positionAddress);
      return t === undefined || now - t >= MIN_APPEND_SPACING_SECONDS;
    });
    if (due.length === 0) return;
    await feeStore.appendMany(
      due.map((v) => ({
        position: v.positionAddress,
        snapshot: {
          t: now,
          whirlpool: v.whirlpool,
          liquidity: v.liquidity.toString(),
          feeGrowthInsideA: v.feeGrowthInsideA!,
          feeGrowthInsideB: v.feeGrowthInsideB!,
          price: v.price,
          inRange: v.inRange,
        },
      })),
    );
  } catch (error) {
    console.error(
      "[position-yield] observation write failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
