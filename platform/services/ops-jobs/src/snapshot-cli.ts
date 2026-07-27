#!/usr/bin/env ts-node
/**
 * One-shot pool snapshot capture.
 *   RPC_URL=... POOLS=addr1,addr2 SNAPSHOT_DIR=... pnpm --filter @lh/ops-jobs snapshot-once
 * Defaults: canonical SOL/USDC pool; dir platform/.data/pool-snapshots;
 * RPC from env or lh-protocol/.env (like the other CLIs).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { Connection } from "@solana/web3.js";
import { FilePoolSnapshotStore, snapshotTvlQuote, isUsdQuote } from "@lh/market-data";
import type { PoolSnapshotStore } from "@lh/market-data";
import {
  createPool,
  PgPoolSnapshotStore,
  PgTrackedPoolStore,
  safeDsn,
  numericEnv,
} from "@lh/storage";
import { captureSnapshots, resolvePoolMetadata, DEFAULT_POOLS } from "./pool-snapshot-job";
import { discoverPoolsByVolume, TrackedPool } from "./pool-discovery";

interface TrackedFile {
  refreshedAt: number;
  pools: TrackedPool[];
}

/**
 * Tracked set: every Orca pool with 24h volume ≥ MIN_POOL_VOLUME_USD
 * (default $10k), refreshed every TRACK_REFRESH_HOURS (default 24) and
 * cached to <SNAPSHOT_DIR>/tracked-pools.json. POOLS (comma-separated)
 * pins an explicit set instead.
 */
/** Env var with a fallback to lh-protocol/.env (local-run convention). */
function envVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envPath = resolve(__dirname, "../../../../lh-protocol/.env");
  if (!existsSync(envPath)) return undefined;
  return readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
}

async function resolveTrackedPools(dir: string): Promise<TrackedPool[]> {
  const file = join(dir, "tracked-pools.json");
  const refreshHours = numericEnv("TRACK_REFRESH_HOURS", 24);
  const minVolume = numericEnv("MIN_POOL_VOLUME_USD", 10_000);
  const maxPools = numericEnv("MAX_TRACKED_POOLS", 400);
  const nowTs = Math.floor(Date.now() / 1000);
  const explicit = process.env.POOLS?.split(",").map((x) => x.trim()).filter(Boolean);

  let cached: TrackedFile | null = null;
  if (existsSync(file)) {
    try {
      cached = JSON.parse(readFileSync(file, "utf8")) as TrackedFile;
    } catch {
      cached = null;
    }
  }
  if (cached && !explicit && nowTs - cached.refreshedAt < refreshHours * 3600) {
    return cached.pools;
  }

  try {
    const d = await discoverPoolsByVolume({ minVolume24hUsdc: minVolume, maxPools });
    const pools = explicit ? d.pools.filter((p) => explicit.includes(p.address)) : d.pools;
    if (pools.length === 0) return DEFAULT_POOLS;
    writeFileSync(file, JSON.stringify({ refreshedAt: nowTs, pools }, null, 2));
    console.log(
      `discovery: tracking ${pools.length} pool(s) with 24h volume ≥ $${minVolume.toLocaleString("en-US")} ` +
        `(scanned ${d.scanned}${d.skippedNoMetadata ? `, skipped ${d.skippedNoMetadata} without token metadata` : ""}` +
        `${d.truncated ? `, TRUNCATED at ${maxPools}` : ""})`,
    );
    return pools;
  } catch (e) {
    console.warn(`discovery failed (${(e as Error).message}) — falling back`);
    return cached?.pools ?? DEFAULT_POOLS;
  }
}

async function main() {
  let rpc = process.env.RPC_URL;
  if (!rpc) {
    const envPath = resolve(__dirname, "../../../../lh-protocol/.env");
    if (existsSync(envPath)) {
      rpc = readFileSync(envPath, "utf8").match(/^ANCHOR_PROVIDER_URL=(.+)$/m)?.[1]?.trim();
    }
  }
  if (!rpc) {
    console.error("RPC_URL missing");
    process.exit(1);
  }
  const dir =
    process.env.SNAPSHOT_DIR ?? resolve(__dirname, "../../../.data/pool-snapshots");

  // Postgres when DATABASE_URL is set (production), files otherwise (dev).
  const dsn = envVar("DATABASE_URL");
  let store: PoolSnapshotStore;
  let trackedStore: PgTrackedPoolStore | null = null;
  if (dsn) {
    const pgPool = createPool({ connectionString: dsn, maxConnections: 4 });
    store = new PgPoolSnapshotStore(pgPool);
    // AUDIT #6: the metadata projection the dataset export joins against.
    trackedStore = new PgTrackedPoolStore(pgPool);
    console.log(`storage: postgres ${safeDsn(dsn)}`);
  } else {
    store = new FilePoolSnapshotStore(dir);
    console.log(`storage: files ${dir}`);
  }
  const connection = new Connection(rpc, "confirmed");
  const loopSeconds = numericEnv("SNAPSHOT_LOOP_SECONDS", 0);

  const once = async () => {
    let pools = await resolveTrackedPools(dir);
    // Pools the Orca list didn't cover get their decimals from the mint
    // accounts themselves — authoritative, and it keeps the tail of the
    // volume distribution in the dataset instead of dropping it.
    const meta = await resolvePoolMetadata(connection, pools);
    if (meta.resolved.length !== pools.length) {
      console.log(
        `metadata: resolved ${meta.resolved.length}/${pools.length} on-chain` +
          (meta.unresolved.length ? `, ${meta.unresolved.length} unreadable` : ""),
      );
    }
    pools = meta.resolved;
    const refreshedAt = Math.floor(Date.now() / 1000);
    writeFileSync(
      join(dir, "tracked-pools.json"),
      JSON.stringify({ refreshedAt, pools }, null, 2),
    );
    // Persist the same metadata to Postgres. The dataset export LEFT JOINs
    // this table for `pair` and the decimals; without it every delivered
    // row carried empty columns (AUDIT #6). Non-fatal: a metadata write
    // must never cost us a snapshot cycle.
    if (trackedStore) {
      try {
        const n = await trackedStore.upsert(
          pools.map((p) => ({
            address: p.address,
            symbolA: p.symbolA,
            symbolB: p.symbolB,
            decimalsA: p.decimalsA,
            decimalsB: p.decimalsB,
            quoteMint: p.quoteMint,
            feeRate: p.feeRate,
          })),
          refreshedAt,
        );
        console.log(`tracked_pools: upserted ${n} rows`);
      } catch (e) {
        console.error(
          "tracked_pools upsert failed (dataset export will have empty pair/decimals):",
          e instanceof Error ? e.message : e,
        );
      }
    }
    const started = Date.now();
    const result = await captureSnapshots(
      connection,
      store,
      pools,
      Math.floor(Date.now() / 1000),
    );
    // TVL is quote-denominated; only USD-quoted pools may be summed.
    let usdTvl = 0;
    let usdPools = 0;
    for (const c of result.captured) {
      const tvl = snapshotTvlQuote(c.snapshot, c.pool.decimalsA, c.pool.decimalsB);
      if (tvl !== null && isUsdQuote(c.pool.quoteMint)) {
        usdTvl += tvl;
        usdPools++;
      }
    }
    console.log(
      `captured ${result.captured.length}/${pools.length} pools in ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
        `TVL across ${usdPools} USD-quoted pools: $${usdTvl.toLocaleString("en-US", { maximumFractionDigits: 0 })} ` +
        `(${result.captured.length - usdPools} pools quote in other tokens — not summable)`,
    );
    for (const c of result.captured.slice(0, 5)) {
      const tvl = snapshotTvlQuote(c.snapshot, c.pool.decimalsA, c.pool.decimalsB);
      const unit = isUsdQuote(c.pool.quoteMint) ? "$" : `${c.pool.symbolB} `;
      console.log(
        `  ${c.pool.symbolA}/${c.pool.symbolB} ${c.pool.address.slice(0, 6)}… ` +
          `price=${c.snapshot.price.toPrecision(6)} TVL=${tvl === null ? "n/a" : unit + tvl.toFixed(0)}`,
      );
    }
    if (result.captured.length > 5) console.log(`  … and ${result.captured.length - 5} more`);
    // P3: coverage is reported every cycle — a silent partial capture in a
    // dataset sold on completeness is a defect, not an inconvenience.
    const coverage = pools.length > 0 ? result.captured.length / pools.length : 1;
    if (coverage < 1) {
      console.error(
        `[collector] DEGRADED CYCLE: ${result.missing.length} pool(s) unreadable ` +
          `(${(coverage * 100).toFixed(1)}% coverage) — gap recorded for backfill`,
      );
      if (!loopSeconds && result.captured.length === 0) process.exit(2);
    }
  };

  await once().catch((e) => console.error("snapshot cycle failed:", e.message ?? e));
  if (loopSeconds > 0) {
    console.log(`collector mode: every ${loopSeconds}s`);
    // Self-scheduling: a cycle that runs long can never overlap the next
    // one (setInterval would double RPC load and connections at scale).
    const tick = () => {
      once()
        .catch((e) => console.error("snapshot cycle failed:", e.message ?? e))
        .finally(() => setTimeout(tick, loopSeconds * 1000));
    };
    setTimeout(tick, loopSeconds * 1000);
  }
}

main().catch((e) => {
  console.error("snapshot capture failed:", e.message ?? e);
  process.exit(1);
});
