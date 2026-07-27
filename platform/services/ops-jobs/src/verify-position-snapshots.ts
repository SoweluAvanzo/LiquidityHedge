/**
 * §1.2 live verification (remediation plan verification strategy #4):
 *
 * A. Independent chain read: for each tracked position, recompute
 *    feeGrowthInside NOW via the fee-reader's own path (mint → position
 *    PDA, individual account fetches at "finalized") and compare
 *    BIT-FOR-BIT with the latest snapshot the collector/dashboard wrote.
 *    All 4 positions are out of range and untouched, so the inside
 *    accumulator must be exactly stable between reads.
 *
 * B. Writer agreement: web-written and collector-written rows for the
 *    same position must carry identical inside values (same reason).
 *
 * C. Cross-path window check: realised fees from position snapshots
 *    (L × Δinside / 2⁶⁴) vs the pool-snapshot path (computeRangeFeeYield
 *    over the same window, same range, same L). Out of range, both must
 *    be exactly zero.
 *
 * Usage (JSON exports because Postgres is not reachable from the host —
 * produce them via `docker exec … psql -t -A -c "SELECT json_agg(…)"`,
 * see REGRESSION_LOG.md):
 *
 *   RPC_URL=… pnpm --filter @lh/ops-jobs verify-positions \
 *     <position-snaps.json> <pool-snaps.json>
 */
import { readFileSync } from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodePositionAccount,
  decodeWhirlpoolAccount,
  readTickFeeGrowthOutside,
} from "@lh/core/src/market-data/decoder";
import { feeGrowthInside } from "@lh/core/src/market-data/fees-owed";
import {
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  tickArrayStartIndex,
} from "@lh/core/src/config/chain";
import {
  measurePositionFees,
  computeRangeFeeYield,
  type PositionFeeSnapshot,
  type PoolSnapshot,
} from "@lh/market-data";

interface StoredRow {
  position: string;
  position_mint: string;
  t: string;
  liquidity: string;
  fee_growth_inside_a: string;
  fee_growth_inside_b: string;
  price: string;
  in_range: boolean;
  whirlpool: string;
  /** From lh.tracked_positions — include in the export; 9/6 (SOL/USDC)
   *  assumed when absent, WRONG for any other pair. */
  decimals_a?: number;
  decimals_b?: number;
}

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL required");
  const connection = new Connection(rpc, "finalized");

  const rows: StoredRow[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const poolSnaps: PoolSnapshot[] = JSON.parse(
    readFileSync(process.argv[3], "utf8"),
  ).map((r: Record<string, string | number>) => ({
    t: Number(r.t),
    price: Number(r.price),
    liquidity: String(r.liquidity),
    feeGrowthGlobalA: String(r.fga),
    feeGrowthGlobalB: String(r.fgb),
    vaultA: r.vault_a === null ? undefined : String(r.vault_a),
    vaultB: r.vault_b === null ? undefined : String(r.vault_b),
  }));

  const byPosition = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const list = byPosition.get(r.position) ?? [];
    list.push(r);
    byPosition.set(r.position, list);
  }

  let failures = 0;
  for (const [position, list] of byPosition) {
    list.sort((a, b) => Number(a.t) - Number(b.t));
    const latest = list[list.length - 1];

    // ── A: independent live read (fee-reader path: mint → PDA) ──────
    const [pda] = deriveOrcaPositionPda(new PublicKey(latest.position_mint));
    if (pda.toBase58() !== position) {
      console.error(`✗ ${position}: PDA from mint mismatch (${pda.toBase58()})`);
      failures++;
      continue;
    }
    // One unreadable account must not abort the remaining positions —
    // count it as a failure and keep verifying.
    const posInfo = await connection.getAccountInfo(pda);
    if (!posInfo) {
      console.error(`✗ ${position}: position account unreadable`);
      failures++;
      continue;
    }
    const pos = decodePositionAccount(posInfo.data);
    const poolInfo = await connection.getAccountInfo(pos.whirlpool);
    if (!poolInfo) {
      console.error(`✗ ${position}: pool unreadable`);
      failures++;
      continue;
    }
    const pool = decodeWhirlpoolAccount(poolInfo.data);
    const readTick = async (tick: number) => {
      const start = tickArrayStartIndex(tick, pool.tickSpacing);
      const [ta] = deriveTickArrayPda(pos.whirlpool, start);
      const info = await connection.getAccountInfo(ta);
      return info ? readTickFeeGrowthOutside(info.data, tick, start, pool.tickSpacing) : null;
    };
    const lower = await readTick(pos.tickLowerIndex);
    const upper = await readTick(pos.tickUpperIndex);
    if (!lower || !upper) {
      console.error(`✗ ${position}: tick array unreadable`);
      failures++;
      continue;
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

    const liveA = inside.insideA.toString();
    const liveB = inside.insideB.toString();
    const okA = liveA === latest.fee_growth_inside_a;
    const okB = liveB === latest.fee_growth_inside_b;
    if (!okA || !okB) failures++;
    console.log(
      `${okA && okB ? "✓" : "✗"} ${position.slice(0, 8)}… A: live=${liveA} stored=${latest.fee_growth_inside_a} ${okA ? "MATCH" : "MISMATCH"}; ` +
        `B: ${okB ? "MATCH" : "MISMATCH"}`,
    );

    // ── B: stored rows identical — VALID ONLY while the position was
    // out of range for the whole window (in range, inside legitimately
    // grows between rows), so gate on the recorded flags.
    if (list.every((r) => !r.in_range)) {
      const distinctA = new Set(list.map((r) => r.fee_growth_inside_a)).size;
      const distinctB = new Set(list.map((r) => r.fee_growth_inside_b)).size;
      if (distinctA !== 1 || distinctB !== 1) {
        console.error(
          `  ✗ writer disagreement: ${distinctA}/${distinctB} distinct inside values across ${list.length} rows`,
        );
        failures++;
      } else {
        console.log(`  ✓ ${list.length} stored rows (web + collector) agree bit-for-bit`);
      }
    } else {
      console.log(`  B skipped (position was in range during the window — inside legitimately moves)`);
    }

    // ── C: realised fees over the stored window vs the pool path ────
    if (list.length >= 2) {
      const posSnaps: PositionFeeSnapshot[] = list.map((r) => ({
        t: Number(r.t),
        whirlpool: r.whirlpool,
        liquidity: r.liquidity,
        feeGrowthInsideA: r.fee_growth_inside_a,
        feeGrowthInsideB: r.fee_growth_inside_b,
        price: Number(r.price),
        inRange: r.in_range,
      }));
      const decA = latest.decimals_a ?? 9;
      const decB = latest.decimals_b ?? 6;
      const measured = measurePositionFees(posSnaps, decA, decB);
      const t0 = Number(list[0].t);
      const t1 = Number(list[list.length - 1].t);
      // Range prices from live position ticks (1.0001^tick, decimal-adjusted)
      const pLower = Math.pow(1.0001, pos.tickLowerIndex) * 10 ** (decA - decB);
      const pUpper = Math.pow(1.0001, pos.tickUpperIndex) * 10 ** (decA - decB);
      const window = poolSnaps.filter((s) => s.t >= t0 - 950 && s.t <= t1 + 950);
      const poolPath =
        window.length >= 2
          ? computeRangeFeeYield(window, pLower, pUpper, BigInt(latest.liquidity))
          : null;
      console.log(
        `  C: realised feesA=${measured?.feesA ?? "n/a"} feesB=${measured?.feesB ?? "n/a"} ` +
          `(window ${t1 - t0}s) vs pool-path feesA=${poolPath?.feesA ?? "n/a"} feesB=${poolPath?.feesB ?? "n/a"} ` +
          `inRangeSeconds=${poolPath?.inRangeSeconds ?? "n/a"}`,
      );
    }
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
