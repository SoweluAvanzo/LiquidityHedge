/**
 * position-value.ts — Orca concentrated liquidity position valuation.
 *
 * Calculates position equity, hold value, and impermanent loss using
 * the concentrated liquidity formulas from the reference implementation
 * (test_deployment_v2/position_monitor.py).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Q64 } from "./config";
import {
  decodeWhirlpoolAccount,
  decodePositionAccount,
  tickToSqrtPriceX64,
  sqrtPriceX64ToPrice,
  deriveOrcaPositionPda,
} from "./whirlpool-ix";

// ─── Core Math ───────────────────────────────────────────────────────

/**
 * Estimate token amounts from position liquidity using concentrated
 * liquidity math. This is the core formula from Uniswap V3 / Orca.
 *
 * Returns raw token amounts (lamports for SOL, micro-units for USDC).
 */
export function estimateTokenAmounts(
  liquidity: bigint,
  sqrtPriceCurrent: bigint,
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint
): { amountA: bigint; amountB: bigint } {
  if (liquidity === BigInt(0)) {
    return { amountA: BigInt(0), amountB: BigInt(0) };
  }

  let amountA: bigint;
  let amountB: bigint;

  if (sqrtPriceCurrent <= sqrtPriceLower) {
    // Price below range: all token A (SOL)
    amountA =
      (liquidity * (sqrtPriceUpper - sqrtPriceLower) * Q64) /
      (sqrtPriceLower * sqrtPriceUpper);
    amountB = BigInt(0);
  } else if (sqrtPriceCurrent >= sqrtPriceUpper) {
    // Price above range: all token B (USDC)
    amountA = BigInt(0);
    amountB =
      (liquidity * (sqrtPriceUpper - sqrtPriceLower)) / Q64;
  } else {
    // Price in range: both tokens
    amountA =
      (liquidity * (sqrtPriceUpper - sqrtPriceCurrent) * Q64) /
      (sqrtPriceCurrent * sqrtPriceUpper);
    amountB =
      (liquidity * (sqrtPriceCurrent - sqrtPriceLower)) / Q64;
  }

  return { amountA, amountB };
}

/**
 * Compute position value in USD.
 * amountA = SOL in lamports (9 decimals)
 * amountB = USDC in micro-units (6 decimals)
 */
export function positionValueUsd(
  amountA: bigint,
  amountB: bigint,
  solPriceUsd: number
): number {
  const solAmount = Number(amountA) / 1e9;
  const usdcAmount = Number(amountB) / 1e6;
  return solAmount * solPriceUsd + usdcAmount;
}

/**
 * Compute hold value: what you'd have if you just held the initial tokens.
 */
export function holdValueUsd(
  initialA: bigint,
  initialB: bigint,
  currentPriceUsd: number
): number {
  const solAmount = Number(initialA) / 1e9;
  const usdcAmount = Number(initialB) / 1e6;
  return solAmount * currentPriceUsd + usdcAmount;
}

/**
 * Compute impermanent loss.
 * IL = positionValue - holdValue (usually negative when price moved)
 */
export function impermanentLoss(
  currentValue: number,
  holdValue: number
): { ilUsd: number; ilPct: number } {
  const ilUsd = currentValue - holdValue;
  const ilPct = holdValue > 0 ? (ilUsd / holdValue) * 100 : 0;
  return { ilUsd, ilPct };
}

// ─── Position Snapshot ───────────────────────────────────────────────

export interface PositionSnapshot {
  timestamp: number;
  price: number;
  amountA: bigint; // SOL in lamports
  amountB: bigint; // USDC in micro-units
  valueUsd: number;
  holdValueUsd: number;
  ilUsd: number;
  ilPct: number;
  isInRange: boolean;
  tickCurrent: number;
  tickLower: number;
  tickUpper: number;
}

/**
 * Take a full position snapshot from on-chain data.
 *
 * @param connection - Solana RPC connection
 * @param positionMint - the Orca position NFT mint
 * @param whirlpoolAddress - the Orca SOL/USDC pool
 * @param initialA - SOL deposited at entry (lamports)
 * @param initialB - USDC deposited at entry (micro-units)
 * @param entryPrice - SOL/USD price at entry
 */
export async function snapshotPosition(
  connection: Connection,
  positionMint: PublicKey,
  whirlpoolAddress: PublicKey,
  initialA: bigint,
  initialB: bigint,
  entryPrice?: number
): Promise<PositionSnapshot> {
  // Fetch Whirlpool state
  const wpInfo = await connection.getAccountInfo(whirlpoolAddress);
  if (!wpInfo) throw new Error("Whirlpool account not found");
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));
  const currentPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);

  // Fetch Orca Position state
  const [orcaPosPda] = deriveOrcaPositionPda(positionMint);
  const posInfo = await connection.getAccountInfo(orcaPosPda);
  if (!posInfo) throw new Error("Orca Position PDA not found");
  const pos = decodePositionAccount(Buffer.from(posInfo.data));

  // Compute current token amounts
  const sqrtPriceLower = tickToSqrtPriceX64(pos.tickLowerIndex);
  const sqrtPriceUpper = tickToSqrtPriceX64(pos.tickUpperIndex);
  const { amountA, amountB } = estimateTokenAmounts(
    pos.liquidity,
    wp.sqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper
  );

  const value = positionValueUsd(amountA, amountB, currentPrice);
  const hold = holdValueUsd(initialA, initialB, currentPrice);
  const il = impermanentLoss(value, hold);
  const isInRange =
    wp.tickCurrentIndex >= pos.tickLowerIndex &&
    wp.tickCurrentIndex < pos.tickUpperIndex;

  return {
    timestamp: Math.floor(Date.now() / 1000),
    price: currentPrice,
    amountA,
    amountB,
    valueUsd: value,
    holdValueUsd: hold,
    ilUsd: il.ilUsd,
    ilPct: il.ilPct,
    isInRange,
    tickCurrent: wp.tickCurrentIndex,
    tickLower: pos.tickLowerIndex,
    tickUpper: pos.tickUpperIndex,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────

export function formatPositionSnapshot(
  snap: PositionSnapshot,
  label: string = ""
): string {
  const solAmt = (Number(snap.amountA) / 1e9).toFixed(9);
  const usdcAmt = (Number(snap.amountB) / 1e6).toFixed(6);
  const lines = [
    label ? `── ${label} ──` : "── Position Snapshot ──",
    `  Time:          ${new Date(snap.timestamp * 1000).toISOString()}`,
    `  SOL Price:     $${snap.price.toFixed(6)}`,
    `  Token A (SOL): ${solAmt} ($${(Number(snap.amountA) / 1e9 * snap.price).toFixed(8)})`,
    `  Token B (USDC): ${usdcAmt}`,
    `  Position value: $${snap.valueUsd.toFixed(8)}`,
    `  Hold value:    $${snap.holdValueUsd.toFixed(8)}`,
    `  IL:            $${snap.ilUsd.toFixed(8)} (${snap.ilPct.toFixed(6)}%)`,
    `  In range:      ${snap.isInRange}`,
    `  Ticks:         [${snap.tickLower}, ${snap.tickUpper}] current=${snap.tickCurrent}`,
  ];
  return lines.join("\n");
}
