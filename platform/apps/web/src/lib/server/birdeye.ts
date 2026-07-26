/**
 * Server-only Birdeye access with a small in-memory TTL cache.
 *
 * Both /api/simulate (daily SOL candles for model calibration) and
 * /api/portfolio (candles for realized vol + pool overview for fee yield)
 * go through this module so the Birdeye API budget is shared: identical
 * requests within the TTL are served from memory.
 *
 * Data-quality rule (§E7, deliberate product decision): incomplete OHLCV
 * coverage is REFUSED loudly by the callers — this module only reports it,
 * it never smooths gaps over.
 */

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import {
  fetchOhlcvPaged,
  makeBirdeyeFetcher,
  makeBirdeyePairFetcher,
  type IngestResult,
} from "@lh/market-data";
import {
  estimatePoolDailyYield,
  fetchPoolOverview,
  type PoolOverview,
} from "@lh/core/src/market-data/orca-volume-adapter";

/** Wrapped SOL mint — the OHLCV subject for all SOL/USDC positions. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry<T> {
  fetchedAt: number;
  value: T;
}

const candleCache = new Map<number, CacheEntry<IngestResult>>();
const overviewCache = new Map<string, CacheEntry<PoolOverview>>();
const pairCandleCache = new Map<string, CacheEntry<IngestResult>>();

/**
 * Pool-overview snapshot ledger: one JSONL line per FRESH overview fetch
 * (cache hits add no information). Groundwork for the measured pool
 * r_pool distribution — once enough daily observations accumulate, this
 * ledger (with real TVL variation) supersedes the volume-only fallback
 * for stochastic fee intensity. Same `.data` policy as the in-range
 * prediction log: append-only, gitignored, a disk failure must never
 * break the request.
 */
const DATA_DIR = path.join(process.cwd(), ".data");
const POOL_OVERVIEW_LEDGER = path.join(DATA_DIR, "pool-overview.jsonl");

function appendPoolOverviewLedger(whirlpool: string, overview: PoolOverview): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      whirlpool,
      volume24h: overview.volume24hUsd,
      tvl: overview.liquidityUsd,
      feeTier: overview.feeTier,
      poolDailyYield: estimatePoolDailyYield(overview),
    };
    appendFileSync(POOL_OVERVIEW_LEDGER, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(
      "[birdeye] pool-overview ledger append failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export function birdeyeApiKey(): string | null {
  const key = process.env.BIRDEYE_API_KEY;
  return key && key.trim() !== "" ? key.trim() : null;
}

/**
 * Daily SOL/USD candles for the window ending now, cached per windowDays.
 * Successful fetches (complete or not) are cached; transport errors are not.
 */
export async function getSolDailyCandles(
  windowDays: number,
): Promise<IngestResult> {
  const cached = candleCache.get(windowDays);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.value;

  const key = birdeyeApiKey();
  if (!key) {
    throw new Error("BIRDEYE_API_KEY is not configured on the server");
  }
  const fetcher = makeBirdeyeFetcher(key);
  const timeTo = Math.floor(now / 1000);
  const timeFrom = timeTo - windowDays * 86_400;
  const result = await fetchOhlcvPaged(fetcher, SOL_MINT, "1D", timeFrom, timeTo);
  candleCache.set(windowDays, { fetchedAt: now, value: result });
  return result;
}

/** Birdeye pair overview for a Whirlpool, cached per (pool, feeTier). */
export async function getPoolOverview(
  poolAddress: string,
  feeTier: number,
): Promise<PoolOverview> {
  const cacheKey = `${poolAddress}:${feeTier}`;
  const cached = overviewCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.value;

  const key = birdeyeApiKey();
  if (!key) {
    throw new Error("BIRDEYE_API_KEY is not configured on the server");
  }
  const overview = await fetchPoolOverview(key, poolAddress, feeTier);
  overviewCache.set(cacheKey, { fetchedAt: now, value: overview });
  appendPoolOverviewLedger(poolAddress, overview);
  return overview;
}

/**
 * Daily PAIR-level candles for a Whirlpool (pool-specific volume in `v`),
 * cached per (pool, windowDays) — the volume series behind stochastic
 * fee-intensity calibration.
 */
export async function getPoolDailyCandles(
  poolAddress: string,
  windowDays: number,
): Promise<IngestResult> {
  const cacheKey = `${poolAddress}:${windowDays}`;
  const cached = pairCandleCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.value;

  const key = birdeyeApiKey();
  if (!key) {
    throw new Error("BIRDEYE_API_KEY is not configured on the server");
  }
  const fetcher = makeBirdeyePairFetcher(key);
  const timeTo = Math.floor(now / 1000);
  const timeFrom = timeTo - windowDays * 86_400;
  const result = await fetchOhlcvPaged(fetcher, poolAddress, "1D", timeFrom, timeTo);
  pairCandleCache.set(cacheKey, { fetchedAt: now, value: result });
  return result;
}
