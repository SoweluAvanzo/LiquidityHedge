/**
 * Position fee-growth snapshot collector (§1.2 realised position yield).
 *
 * For every tracked position (auto-registered by the dashboard, see
 * lh.tracked_positions) it reconstructs `feeGrowthInside` from the pool
 * and tick accounts — the same computation `collectFees` itself performs
 * — and persists one reading per cycle. Realised position fees over any
 * window are then `L × Δinside / 2⁶⁴`, replacing the modelled
 * r_pool × in-range-fraction × concentration chain with a measurement.
 *
 * Account cost per cycle: 1 read per position + 1 per distinct pool +
 * 1 per distinct tick array, batched 100/call alongside the pool cycle.
 *
 * Failure policy: an unreadable position/pool/tick yields NO snapshot for
 * that position this cycle (reported in `missing`) — a gap in the series
 * is visible and bounded by the gap policy downstream; a guessed value
 * would poison the measurement invisibly.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodePositionAccount,
  decodeWhirlpoolAccount,
  readTickFeeGrowthOutside,
  sqrtPriceX64ToPrice,
  type WhirlpoolData,
} from "@lh/core/src/market-data/decoder";
import { feeGrowthInside } from "@lh/core/src/market-data/fees-owed";
import {
  deriveTickArrayPda,
  tickArrayStartIndex,
} from "@lh/core/src/config/chain";
import type { PositionFeeSnapshot } from "@lh/market-data";
import type { TrackedPositionRow } from "@lh/storage";
import { readAccounts } from "./pool-snapshot-job";

export interface PositionSnapshotRunResult {
  captured: { position: string; snapshot: PositionFeeSnapshot }[];
  missing: string[];
}

export async function capturePositionSnapshots(
  connection: Connection,
  tracked: TrackedPositionRow[],
  nowTs: number,
): Promise<PositionSnapshotRunResult> {
  const captured: PositionSnapshotRunResult["captured"] = [];
  const missing: string[] = [];
  if (tracked.length === 0) return { captured, missing };

  const posData = await readAccounts(
    connection,
    tracked.map((p) => new PublicKey(p.position)),
  );
  const decodedPos = posData.map((d) => {
    if (!d) return null;
    try {
      return decodePositionAccount(d);
    } catch {
      return null;
    }
  });

  const poolKeys = [
    ...new Set(
      decodedPos.flatMap((p) => (p ? [p.whirlpool.toBase58()] : [])),
    ),
  ];
  const poolData = await readAccounts(
    connection,
    poolKeys.map((k) => new PublicKey(k)),
  );
  const pools = new Map<string, WhirlpoolData>();
  poolKeys.forEach((k, i) => {
    const d = poolData[i];
    if (!d) return;
    try {
      pools.set(k, decodeWhirlpoolAccount(d));
    } catch {
      // undecodable pool — its positions are reported missing below
    }
  });

  // Distinct tick arrays across all positions, one batched read.
  const taKeys: PublicKey[] = [];
  const taIndex = new Map<string, number>();
  decodedPos.forEach((pos) => {
    if (!pos) return;
    const pool = pools.get(pos.whirlpool.toBase58());
    if (!pool) return;
    for (const tick of [pos.tickLowerIndex, pos.tickUpperIndex]) {
      const start = tickArrayStartIndex(tick, pool.tickSpacing);
      const [pda] = deriveTickArrayPda(pos.whirlpool, start);
      const key = pda.toBase58();
      if (!taIndex.has(key)) {
        taIndex.set(key, taKeys.length);
        taKeys.push(pda);
      }
    }
  });
  const taData = taKeys.length > 0 ? await readAccounts(connection, taKeys) : [];

  tracked.forEach((row, i) => {
    const pos = decodedPos[i];
    const pool = pos ? pools.get(pos.whirlpool.toBase58()) : undefined;
    if (!pos || !pool) {
      missing.push(row.position);
      return;
    }
    const readTick = (tick: number) => {
      const start = tickArrayStartIndex(tick, pool.tickSpacing);
      const [pda] = deriveTickArrayPda(pos.whirlpool, start);
      const data = taData[taIndex.get(pda.toBase58())!];
      return data
        ? readTickFeeGrowthOutside(data, tick, start, pool.tickSpacing)
        : null;
    };
    const lower = readTick(pos.tickLowerIndex);
    const upper = readTick(pos.tickUpperIndex);
    if (!lower || !upper) {
      missing.push(row.position);
      return;
    }
    const inside = feeGrowthInside({
      tickCurrentIndex: pool.tickCurrentIndex,
      tickLowerIndex: pos.tickLowerIndex,
      tickUpperIndex: pos.tickUpperIndex,
      feeGrowthGlobalA: pool.feeGrowthGlobalA,
      feeGrowthGlobalB: pool.feeGrowthGlobalB,
      lowerOutsideA: lower.feeGrowthOutsideA,
      lowerOutsideB: lower.feeGrowthOutsideB,
      upperOutsideA: upper.feeGrowthOutsideA,
      upperOutsideB: upper.feeGrowthOutsideB,
    });
    captured.push({
      position: row.position,
      snapshot: {
        t: nowTs,
        whirlpool: pos.whirlpool.toBase58(),
        liquidity: pos.liquidity.toString(),
        feeGrowthInsideA: inside.insideA.toString(),
        feeGrowthInsideB: inside.insideB.toString(),
        price: sqrtPriceX64ToPrice(pool.sqrtPrice, row.decimalsA, row.decimalsB),
        inRange:
          pool.tickCurrentIndex >= pos.tickLowerIndex &&
          pool.tickCurrentIndex < pos.tickUpperIndex,
      },
    });
  });
  return { captured, missing };
}
