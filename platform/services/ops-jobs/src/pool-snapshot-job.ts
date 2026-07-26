/**
 * Pool snapshot collector (Tier-C yield history). One batched RPC read per
 * run captures feeGrowthGlobalA/B, active liquidity, and price for every
 * tracked pool. Run every 15 minutes (cron / compose profile "jobs").
 *
 * Pool-level data generalizes to EVERY position in the pool — no
 * position-specific reads are needed (see
 * @lh/market-data/src/pool-snapshots.ts).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeWhirlpoolAccount,
  sqrtPriceX64ToPrice,
} from "@lh/core/src/market-data/decoder";
import { FilePoolSnapshotStore, PoolSnapshot } from "@lh/market-data";

/** Canonical mainnet SOL/USDC whirlpool (0.04% tier, tick spacing 64). */
export const DEFAULT_POOLS = ["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"];

export interface SnapshotRunResult {
  captured: { pool: string; snapshot: PoolSnapshot }[];
  missing: string[];
}

export async function captureSnapshots(
  connection: Connection,
  store: FilePoolSnapshotStore,
  poolAddresses: string[],
  nowTs: number,
  // SOL/USDC decimals by default; per-pool decimals can be resolved from
  // the mints when non-SOL/USDC pools are onboarded.
  decimalsA = 9,
  decimalsB = 6,
): Promise<SnapshotRunResult> {
  const keys = poolAddresses.map((a) => new PublicKey(a));
  const infos = await connection.getMultipleAccountsInfo(keys);
  const captured: SnapshotRunResult["captured"] = [];
  const missing: string[] = [];

  for (let i = 0; i < keys.length; i++) {
    const info = infos[i];
    if (!info) {
      missing.push(poolAddresses[i]);
      continue;
    }
    const pool = decodeWhirlpoolAccount(info.data);
    const snapshot: PoolSnapshot = {
      t: nowTs,
      price: sqrtPriceX64ToPrice(pool.sqrtPrice, decimalsA, decimalsB),
      liquidity: pool.liquidity.toString(),
      feeGrowthGlobalA: pool.feeGrowthGlobalA.toString(),
      feeGrowthGlobalB: pool.feeGrowthGlobalB.toString(),
    };
    await store.append(poolAddresses[i], snapshot);
    captured.push({ pool: poolAddresses[i], snapshot });
  }
  return { captured, missing };
}
