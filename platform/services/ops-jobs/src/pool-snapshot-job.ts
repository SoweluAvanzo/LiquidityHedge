/**
 * Pool snapshot collector (Tier-C yield history), multi-pool.
 *
 * Per pool it reads the whirlpool account plus its two vaults — 3 accounts
 * — batched at 100 accounts per RPC call, so tracking 50 pools costs ~2
 * calls per cycle. Pool-level data generalizes to EVERY position in each
 * pool (see packages/market-data/src/pool-snapshots.ts), so this single
 * feed serves any position or hypothetical range in any tracked pool.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeWhirlpoolAccount,
  sqrtPriceX64ToPrice,
} from "@lh/core/src/market-data/decoder";
import { PoolSnapshot, PoolSnapshotStore } from "@lh/market-data";
import { TrackedPool } from "./pool-discovery";

/** Canonical mainnet SOL/USDC whirlpool (0.04% tier) — the fallback set. */
export const DEFAULT_POOLS: TrackedPool[] = [
  {
    address: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    symbolA: "SOL",
    symbolB: "USDC",
    decimalsA: 9,
    decimalsB: 6,
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    feeRate: 400,
    tvlUsdcAtDiscovery: 0,
  },
];

export interface SnapshotRunResult {
  captured: { pool: TrackedPool; snapshot: PoolSnapshot }[];
  missing: string[];
}

/** SPL token account layout: amount is the u64 LE at offset 64. */
function readAmount(data: Buffer | undefined): string | undefined {
  return data && data.length >= 72 ? data.readBigUInt64LE(64).toString() : undefined;
}

/** SPL mint layout: decimals is the u8 at offset 44. */
function readDecimals(data: Buffer | undefined): number | undefined {
  return data && data.length >= 45 ? data.readUInt8(44) : undefined;
}

/**
 * Fill in decimals/mints for pools whose metadata the Orca list lacks, by
 * reading the mint accounts — the authoritative source. Pools that still
 * cannot be resolved are returned in `unresolved` and never guessed.
 */
export async function resolvePoolMetadata(
  connection: Connection,
  pools: TrackedPool[],
): Promise<{ resolved: TrackedPool[]; unresolved: string[] }> {
  const needing = pools.filter((p) => p.decimalsA < 0 || p.decimalsB < 0);
  if (needing.length === 0) return { resolved: pools, unresolved: [] };

  const poolData = await readAccounts(
    connection,
    needing.map((p) => new PublicKey(p.address)),
  );
  const mintKeys: PublicKey[] = [];
  const decodedByIndex = new Map<number, ReturnType<typeof decodeWhirlpoolAccount>>();
  needing.forEach((_, i) => {
    const d = poolData[i];
    if (!d) return;
    try {
      const pool = decodeWhirlpoolAccount(d);
      decodedByIndex.set(i, pool);
      mintKeys.push(pool.tokenMintA, pool.tokenMintB);
    } catch {
      /* unreadable — reported below */
    }
  });
  const mintData = mintKeys.length > 0 ? await readAccounts(connection, mintKeys) : [];

  const unresolved: string[] = [];
  let cursor = 0;
  const patched = new Map<string, TrackedPool>();
  needing.forEach((p, i) => {
    const pool = decodedByIndex.get(i);
    if (!pool) {
      unresolved.push(p.address);
      return;
    }
    const dA = readDecimals(mintData[cursor++]);
    const dB = readDecimals(mintData[cursor++]);
    if (dA === undefined || dB === undefined) {
      unresolved.push(p.address);
      return;
    }
    patched.set(p.address, {
      ...p,
      decimalsA: dA,
      decimalsB: dB,
      quoteMint: pool.tokenMintB.toBase58(),
      symbolA: p.symbolA || pool.tokenMintA.toBase58().slice(0, 4),
      symbolB: p.symbolB || pool.tokenMintB.toBase58().slice(0, 4),
    });
  });

  const resolved = pools
    .map((p) => patched.get(p.address) ?? p)
    .filter((p) => p.decimalsA >= 0 && p.decimalsB >= 0);
  return { resolved, unresolved };
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * P3: batched reads with jittered retry. A single provider 429/5xx used to
 * abort the whole cycle, silently losing a 15-minute slot for every pool —
 * an invisible hole in a dataset sold on completeness. Now each batch is
 * retried; a batch that still fails yields undefined entries so the rest of
 * the cycle is preserved and the affected pools are reported as missing.
 */
async function readAccounts(
  connection: Connection,
  keys: PublicKey[],
  attempts = 3,
): Promise<(Buffer | undefined)[]> {
  const out: (Buffer | undefined)[] = [];
  for (const batch of chunk(keys, 100)) {
    let got: (Buffer | undefined)[] | null = null;
    for (let attempt = 1; attempt <= attempts && !got; attempt++) {
      try {
        const infos = await connection.getMultipleAccountsInfo(batch);
        got = infos.map((info) => info?.data);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (attempt === attempts) {
          console.error(`[collector] batch failed after ${attempts} attempts: ${msg}`);
          got = batch.map(() => undefined);
        } else {
          const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
          console.warn(`[collector] retry ${attempt}/${attempts} in ${backoff}ms (${msg.slice(0, 60)})`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    out.push(...(got ?? batch.map(() => undefined)));
  }
  return out;
}

export async function captureSnapshots(
  connection: Connection,
  store: PoolSnapshotStore,
  pools: TrackedPool[],
  nowTs: number,
): Promise<SnapshotRunResult> {
  const captured: SnapshotRunResult["captured"] = [];
  const missing: string[] = [];

  const poolData = await readAccounts(
    connection,
    pools.map((p) => new PublicKey(p.address)),
  );

  // Decode first so vault addresses are known, then batch-read all vaults.
  const decoded = poolData.map((d) => {
    if (!d) return null;
    try {
      return decodeWhirlpoolAccount(d);
    } catch {
      return null; // not a decodable whirlpool — reported as missing
    }
  });
  const vaultKeys: PublicKey[] = [];
  for (const pool of decoded) {
    if (pool) vaultKeys.push(pool.tokenVaultA, pool.tokenVaultB);
  }
  const vaultData = vaultKeys.length > 0 ? await readAccounts(connection, vaultKeys) : [];

  let vaultCursor = 0;
  for (let i = 0; i < pools.length; i++) {
    const decodedPool = decoded[i];
    if (!decodedPool) {
      missing.push(pools[i].address);
      continue;
    }
    const vA = vaultData[vaultCursor++];
    const vB = vaultData[vaultCursor++];
    const snapshot: PoolSnapshot = {
      t: nowTs,
      price: sqrtPriceX64ToPrice(
        decodedPool.sqrtPrice,
        pools[i].decimalsA,
        pools[i].decimalsB,
      ),
      liquidity: decodedPool.liquidity.toString(),
      feeGrowthGlobalA: decodedPool.feeGrowthGlobalA.toString(),
      feeGrowthGlobalB: decodedPool.feeGrowthGlobalB.toString(),
      vaultA: readAmount(vA),
      vaultB: readAmount(vB),
    };
    captured.push({ pool: pools[i], snapshot });
  }
  // P1: a single batched write per cycle — one fsync instead of N, and the
  // cycle lands atomically rather than as a torn partial set.
  const batch = store as { appendMany?: (rows: { pool: string; snapshot: PoolSnapshot }[]) => Promise<number> };
  if (typeof batch.appendMany === "function") {
    await batch.appendMany(captured.map((c) => ({ pool: c.pool.address, snapshot: c.snapshot })));
  } else {
    for (const c of captured) await store.append(c.pool.address, c.snapshot);
  }
  return { captured, missing };
}
