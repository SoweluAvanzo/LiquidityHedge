/**
 * Realised position-level fee yield (§1.2).
 *
 * Where §1.1 measured the POOL's yield and still multiplied two estimates
 * on top (in-range fraction, concentration factor), this measures the
 * position itself: `L × Δ feeGrowthInside / 2⁶⁴` over the trailing
 * snapshot window is exactly what the position earned — occupancy and
 * concentration are inside the accumulator, not modelled.
 *
 * Sources of history:
 *  - the collector snapshots every tracked position each 15-min cycle;
 *  - the dashboard opportunistically appends a snapshot whenever it
 *    serves a position (the discovery path already reconstructs
 *    feeGrowthInside for the exact-fees display — persisting it is free).
 *
 * Failure policy: insufficient history returns { ok:false, reason } and
 * the caller falls back to the §1.1 modelled chain, LABELLED as such.
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

/** Trailing lookback over which position snapshots are read. */
const LOOKBACK_SECONDS = numericEnv("POSITION_YIELD_LOOKBACK_SECONDS", 7 * 86_400);
/** Minimum integrated coverage before the realised figure is served. */
const MIN_COVERED_SECONDS = numericEnv(
  "POSITION_YIELD_MIN_COVERED_SECONDS",
  6 * 3_600,
);
/** Collector cadence is 900s; longer intervals are collector outages. */
const MAX_GAP_SECONDS = numericEnv("POSITION_YIELD_MAX_GAP_SECONDS", 3_600);

export type RealisedPositionYieldResult =
  | {
      ok: true;
      /** Realised daily fee yield on the position's CURRENT value. */
      dailyYield: number;
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
    const snapshots = await store.read(
      view.positionAddress,
      now - LOOKBACK_SECONDS,
      now,
    );
    if (snapshots.length < 2) {
      return {
        ok: false,
        reason: `position history too short (${snapshots.length} snapshot(s) in the last ${Math.round(LOOKBACK_SECONDS / 3600)}h)`,
      };
    }
    const measured = measurePositionFees(
      snapshots,
      view.decimalsA,
      view.decimalsB,
      { maxGapSeconds: MAX_GAP_SECONDS },
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
    return {
      ok: true,
      dailyYield:
        measured.feesQuote / view.valueQuote / (measured.coveredSeconds / 86_400),
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
 * Register the served positions for collector tracking and persist their
 * just-computed feeGrowthInside as an opportunistic snapshot. Both are
 * best-effort: a DB hiccup must never break the portfolio response.
 */
export async function recordPositionObservations(
  views: PortfolioPositionView[],
): Promise<void> {
  const db = getDbPool();
  if (!db) return;
  const eligible = views.filter(
    (v) => v.isUsdcQuoted && v.feeGrowthInsideA !== undefined && v.feeGrowthInsideB !== undefined,
  );
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
    await new PgPositionFeeStore(db).appendMany(
      eligible.map((v) => ({
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
