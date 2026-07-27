/**
 * Measured pool fee yield from our own fee-growth snapshots (§1.1).
 *
 * The collector records `feeGrowthGlobalA/B` (the accumulator the
 * Whirlpool program itself pays LPs from), active liquidity and vault
 * balances every 15 minutes. Realised LP yield over the trailing window
 * is then a pure computation — no vendor volume, no vendor TVL, and the
 * protocol-fee share is already inside the accumulator.
 *
 * Failure policy: any missing input returns { ok: false, reason } and the
 * caller falls back to the Birdeye-modelled estimate, LABELLED as such on
 * the wire — a modelled number must never dress up as a measurement.
 */

import {
  measurePoolDailyYield,
  snapshotTvlQuote,
  isUsdQuote,
  type MeasuredPoolYield,
} from "@lh/market-data";
import { PgPoolSnapshotStore, numericEnv } from "@lh/storage";
import { getDbPool } from "./db";

/** Trailing lookback over which snapshots are read. */
const LOOKBACK_SECONDS = numericEnv("POOL_YIELD_LOOKBACK_SECONDS", 7 * 86_400);
/** Minimum integrated coverage for the measurement to be served at all —
 *  below this the estimate's own noise defeats the point of measuring. */
const MIN_COVERED_SECONDS = numericEnv("POOL_YIELD_MIN_COVERED_SECONDS", 6 * 3_600);
/** Collector cadence is 900s; a longer interval means a collector outage. */
const MAX_GAP_SECONDS = numericEnv("POOL_YIELD_MAX_GAP_SECONDS", 3_600);
/** How stale the newest snapshot may be before its TVL is not "current". */
const TVL_FRESH_SECONDS = numericEnv("POOL_YIELD_TVL_FRESH_SECONDS", 3_600);
/**
 * Maximum age of the window's END before "measured" would be a lie: a
 * dead collector must NOT keep serving days-old data as a measurement —
 * a 3-day-old fee regime is routinely worse than the live model. 4× the
 * collector cadence tolerates transient outages only.
 */
const MAX_WINDOW_AGE_SECONDS = numericEnv("POOL_YIELD_MAX_AGE_SECONDS", 3_600);

export type MeasuredPoolYieldResult =
  | {
      ok: true;
      measured: MeasuredPoolYield;
      /** Exact on-chain TVL (vaults) from the newest snapshot, when that
       *  snapshot is fresh — the vendor-free input for the concentration
       *  factor. Null when the newest snapshot is stale or vaultless. */
      latestTvlQuote: number | null;
    }
  | { ok: false; reason: string };

export async function readMeasuredPoolYield(
  poolAddress: string,
  decimalsA: number,
  decimalsB: number,
  quoteMint: string,
): Promise<MeasuredPoolYieldResult> {
  if (!isUsdQuote(quoteMint)) {
    // Quote-denominated yield is only USD when the quote token is a USD
    // stablecoin; other pools would mix units with the USD position value.
    return { ok: false, reason: "pool quote token is not a USD stablecoin" };
  }
  const db = getDbPool();
  if (!db) {
    return { ok: false, reason: "no DATABASE_URL configured (snapshot history unavailable)" };
  }
  try {
    const store = new PgPoolSnapshotStore(db);
    const now = Math.floor(Date.now() / 1000);
    const snapshots = await store.read(poolAddress, now - LOOKBACK_SECONDS, now);
    if (snapshots.length < 2) {
      return {
        ok: false,
        reason: `snapshot history too short (${snapshots.length} snapshot(s) in the last ${Math.round(LOOKBACK_SECONDS / 3600)}h)`,
      };
    }
    const measured = measurePoolDailyYield(snapshots, decimalsA, decimalsB, {
      maxGapSeconds: MAX_GAP_SECONDS,
    });
    if (!measured) {
      return { ok: false, reason: "no usable snapshot interval (missing vault data or broken accumulator)" };
    }
    if (measured.coveredSeconds < MIN_COVERED_SECONDS) {
      return {
        ok: false,
        reason: `snapshot coverage ${(measured.coveredSeconds / 3600).toFixed(1)}h below the ${Math.round(MIN_COVERED_SECONDS / 3600)}h minimum`,
      };
    }
    if (now - measured.lastT > MAX_WINDOW_AGE_SECONDS) {
      return {
        ok: false,
        reason: `snapshot window stale (ended ${((now - measured.lastT) / 3600).toFixed(1)}h ago — collector down?)`,
      };
    }

    const newest = snapshots[snapshots.length - 1];
    const latestTvlQuote =
      now - newest.t <= TVL_FRESH_SECONDS
        ? snapshotTvlQuote(newest, decimalsA, decimalsB)
        : null;
    return { ok: true, measured, latestTvlQuote };
  } catch (error) {
    // DB trouble must degrade to the modelled path, never 500 the route.
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[pool-yield] snapshot read failed for ${poolAddress}: ${msg}`);
    return { ok: false, reason: "snapshot store unavailable" };
  }
}
