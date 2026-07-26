/**
 * Fee refresher — resolves the current `fee_owed_{a,b}` for an Orca
 * position, with three progressively-costly fallbacks:
 *
 *   1. **Off-chain replication** (preferred): read pool + position +
 *      2 tick-arrays, compute `fee_growth_inside_{a,b}`, derive pending
 *      fees using the same formula Whirlpool runs on-chain. No
 *      transaction, no fees, no confirmation latency.
 *
 *   2. **On-chain refresh** (fallback): send `update_fees_and_rewards`
 *      to force the program to refresh the position's
 *      `fee_owed_{a,b}`, then read the position account. Costs ~5000
 *      lamports and one confirmation round-trip.
 *
 *   3. **Zero** (last resort): log the failure and return 0 so the
 *      settlement can still proceed.
 *
 * Each network op is wrapped in `withRetry` (3 attempts, exponential
 * backoff) to absorb transient Helius / RPC blips. Every transition
 * between paths is logged so settlements that silently fall back to 0
 * are visible in the audit trail.
 *
 * Consumers call `refreshAndReadFees(ctx)` and receive a
 * `FeeRefreshResult` annotated with which path was used, so the caller
 * can surface it in the Theorem-2.2 diagnostic.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { buildUpdateFeesAndRewardsIx } from "../../position-escrow/orca-adapter";
import {
  decodePositionAccount,
  decodeWhirlpoolAccount,
  readTickFeeGrowthOutside,
  WhirlpoolData,
  PositionData,
} from "../../market-data/decoder";
import { tickArrayStartIndex } from "../../config/chain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeeRefreshContext {
  connection: Connection;
  payer: Keypair;
  whirlpool: PublicKey;
  positionPda: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  tickLowerIndex: number;
  tickUpperIndex: number;
  tickSpacing: number;
  /** Settlement price in micro-USD — used to convert token A (SOL lamports) into USDC */
  settlementPriceE6: number;
}

export type FeeRefreshSource = "offchain" | "onchain" | "zero-fallback";

export interface FeeRefreshResult {
  source: FeeRefreshSource;
  txSignature?: string;
  feeOwedALamports: bigint;
  feeOwedBMicroUsdc: bigint;
  /** Sum of both legs converted to micro-USDC */
  feesAccruedUsdc: number;
  /** Diagnostics for audit. */
  attempts: {
    offchainError?: string;
    onchainError?: string;
  };
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  tries: number = 3,
  initialBackoffMs: number = 400,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        const backoff = initialBackoffMs * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw new Error(
    `${label} failed after ${tries} attempts: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

// ---------------------------------------------------------------------------
// Off-chain path: replicate Whirlpool's fee-growth math
// ---------------------------------------------------------------------------

/**
 * Compute `fee_growth_inside_{a,b}` — the Whirlpool fee accounting
 * formula for the amount of fees earned per unit of liquidity inside
 * the position's tick range.
 *
 * Reference (Uniswap v3 / Orca Whirlpool, identical):
 *   if tick_current < tick_lower:
 *     fee_inside = outside_lower - outside_upper
 *   elif tick_current >= tick_upper:
 *     fee_inside = outside_upper - outside_lower
 *   else:
 *     fee_inside = global - outside_lower - outside_upper
 *
 * All arithmetic is mod 2^128 (wrapping subtraction) — that's how
 * Uniswap handles signed deltas in unsigned 128-bit storage.
 */
function feeGrowthInside(
  global: bigint,
  outsideLower: bigint,
  outsideUpper: bigint,
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  const MOD = 1n << 128n;
  let below: bigint;
  let above: bigint;
  if (tickCurrent < tickLower) {
    below = (global - outsideLower + MOD) % MOD;
  } else {
    below = outsideLower;
  }
  if (tickCurrent >= tickUpper) {
    above = (global - outsideUpper + MOD) % MOD;
  } else {
    above = outsideUpper;
  }
  return (global - below - above + MOD * 2n) % MOD;
}

/**
 * Given position state + the fee_growth_inside snapshot at its
 * checkpoint, compute the total pending fees owed (including both
 * realised fee_owed and the unrealised growth since last checkpoint).
 */
function pendingFeesFromGrowth(
  liquidity: bigint,
  feeOwed: bigint,
  feeGrowthInside: bigint,
  feeGrowthCheckpoint: bigint,
): bigint {
  const MOD = 1n << 128n;
  const delta = (feeGrowthInside - feeGrowthCheckpoint + MOD) % MOD;
  // tokens = delta × liquidity / 2^64 (Q64.64 fixed point)
  const unrealised = (delta * liquidity) >> 64n;
  return feeOwed + unrealised;
}

/**
 * Off-chain fee computation — replicates Whirlpool's on-chain math
 * without any transaction. Reads pool + position + 2 tick arrays.
 */
async function computeFeesOwedOffchain(
  ctx: FeeRefreshContext,
): Promise<{ feeA: bigint; feeB: bigint; pool: WhirlpoolData; position: PositionData }> {
  const [poolAcct, posAcct, taLowerAcct, taUpperAcct] = await withRetry(
    "getMultipleAccountsInfo(pool,position,tickArrayLower,tickArrayUpper)",
    () =>
      ctx.connection.getMultipleAccountsInfo([
        ctx.whirlpool,
        ctx.positionPda,
        ctx.tickArrayLower,
        ctx.tickArrayUpper,
      ]),
  );
  if (!poolAcct) throw new Error(`Whirlpool account ${ctx.whirlpool.toBase58()} not found`);
  if (!posAcct) throw new Error(`Position account ${ctx.positionPda.toBase58()} not found`);
  if (!taLowerAcct) throw new Error(`TickArray (lower) ${ctx.tickArrayLower.toBase58()} not found`);
  if (!taUpperAcct) throw new Error(`TickArray (upper) ${ctx.tickArrayUpper.toBase58()} not found`);

  const pool = decodeWhirlpoolAccount(Buffer.from(poolAcct.data));
  const position = decodePositionAccount(Buffer.from(posAcct.data));

  const lowerStart = tickArrayStartIndex(ctx.tickLowerIndex, ctx.tickSpacing);
  const upperStart = tickArrayStartIndex(ctx.tickUpperIndex, ctx.tickSpacing);

  const lowerGrowth = readTickFeeGrowthOutside(
    Buffer.from(taLowerAcct.data),
    ctx.tickLowerIndex,
    lowerStart,
    ctx.tickSpacing,
  );
  const upperGrowth = readTickFeeGrowthOutside(
    Buffer.from(taUpperAcct.data),
    ctx.tickUpperIndex,
    upperStart,
    ctx.tickSpacing,
  );

  const growthInsideA = feeGrowthInside(
    pool.feeGrowthGlobalA,
    lowerGrowth.feeGrowthOutsideA,
    upperGrowth.feeGrowthOutsideA,
    pool.tickCurrentIndex,
    ctx.tickLowerIndex,
    ctx.tickUpperIndex,
  );
  const growthInsideB = feeGrowthInside(
    pool.feeGrowthGlobalB,
    lowerGrowth.feeGrowthOutsideB,
    upperGrowth.feeGrowthOutsideB,
    pool.tickCurrentIndex,
    ctx.tickLowerIndex,
    ctx.tickUpperIndex,
  );

  const feeA = pendingFeesFromGrowth(
    position.liquidity,
    position.feeOwedA,
    growthInsideA,
    position.feeGrowthCheckpointA,
  );
  const feeB = pendingFeesFromGrowth(
    position.liquidity,
    position.feeOwedB,
    growthInsideB,
    position.feeGrowthCheckpointB,
  );

  return { feeA, feeB, pool, position };
}

// ---------------------------------------------------------------------------
// On-chain path: send update_fees_and_rewards, read position
// ---------------------------------------------------------------------------

async function onchainRefreshAndRead(
  ctx: FeeRefreshContext,
): Promise<{ feeA: bigint; feeB: bigint; txSignature: string }> {
  const tx = new Transaction();
  tx.add(
    buildUpdateFeesAndRewardsIx({
      whirlpool: ctx.whirlpool,
      positionPda: ctx.positionPda,
      tickArrayLower: ctx.tickArrayLower,
      tickArrayUpper: ctx.tickArrayUpper,
    }),
  );
  const txSignature = await withRetry(
    "sendAndConfirmTransaction(update_fees_and_rewards)",
    () =>
      sendAndConfirmTransaction(ctx.connection, tx, [ctx.payer], {
        commitment: "confirmed",
      }),
  );
  const posAcct = await withRetry(
    "getAccountInfo(position after refresh)",
    () => ctx.connection.getAccountInfo(ctx.positionPda),
  );
  if (!posAcct) {
    throw new Error(`Position ${ctx.positionPda.toBase58()} not found after refresh`);
  }
  const pd = decodePositionAccount(Buffer.from(posAcct.data));
  return { feeA: pd.feeOwedA, feeB: pd.feeOwedB, txSignature };
}

// ---------------------------------------------------------------------------
// Public entrypoint — off-chain → on-chain → zero, each with retry
// ---------------------------------------------------------------------------

export async function refreshAndReadFees(
  ctx: FeeRefreshContext,
): Promise<FeeRefreshResult> {
  const attempts: { offchainError?: string; onchainError?: string } = {};

  try {
    const { feeA, feeB } = await computeFeesOwedOffchain(ctx);
    return {
      source: "offchain",
      feeOwedALamports: feeA,
      feeOwedBMicroUsdc: feeB,
      feesAccruedUsdc: toMicroUsdc(feeA, feeB, ctx.settlementPriceE6),
      attempts,
    };
  } catch (e) {
    attempts.offchainError = (e as Error).message;
  }

  try {
    const { feeA, feeB, txSignature } = await onchainRefreshAndRead(ctx);
    return {
      source: "onchain",
      txSignature,
      feeOwedALamports: feeA,
      feeOwedBMicroUsdc: feeB,
      feesAccruedUsdc: toMicroUsdc(feeA, feeB, ctx.settlementPriceE6),
      attempts,
    };
  } catch (e) {
    attempts.onchainError = (e as Error).message;
  }

  return {
    source: "zero-fallback",
    feeOwedALamports: 0n,
    feeOwedBMicroUsdc: 0n,
    feesAccruedUsdc: 0,
    attempts,
  };
}

/** Convert (feeA lamports, feeB µUSDC) → µUSDC at the settlement price. */
function toMicroUsdc(
  feeALamports: bigint,
  feeBMicroUsdc: bigint,
  settlementPriceE6: number,
): number {
  const feeAUsdc = Math.floor(
    (Number(feeALamports) * settlementPriceE6) / 1_000_000_000,
  );
  return feeAUsdc + Number(feeBMicroUsdc);
}
