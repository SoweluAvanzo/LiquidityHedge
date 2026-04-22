/**
 * Orca Whirlpool account decoders and CL math utilities.
 *
 * This is the read-side of the Orca integration: decode on-chain
 * account state into typed TypeScript structs. Paired with
 * `position-escrow/orca-adapter.ts`, which owns the write-side
 * (instruction builders) — the two are split cleanly so the
 * write-side can later move to an on-chain program while the
 * read-side stays off-chain.
 *
 * Ported from `lh-protocol/clients/whirlpool-ix.ts`; shares the
 * same byte layout definitions as that file once did.
 */

import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Q64 fixed-point factor (2^64) for sqrt price calculations. */
const Q64 = BigInt(1) << BigInt(64);

/** Orca account discriminators for data validation. */
const ACCOUNT_DISCRIMINATORS = {
  whirlpool: Buffer.from([63, 149, 209, 12, 225, 128, 99, 9]),
  position: Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]),
} as const;

// ---------------------------------------------------------------------------
// Decoded account types
// ---------------------------------------------------------------------------

/** Decoded on-chain Orca Whirlpool account data. */
export interface WhirlpoolData {
  tickSpacing: number;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  feeRate: number;
  /** Total in-range liquidity at the current tick (u128). This is the
   *  denominator for concentration-factor calculations. */
  liquidity: bigint;
  /** Cumulative fee growth per unit of in-range liquidity, token A (Q64.64 u128). */
  feeGrowthGlobalA: bigint;
  /** Cumulative fee growth per unit of in-range liquidity, token B (Q64.64 u128). */
  feeGrowthGlobalB: bigint;
}

/** Decoded on-chain Orca Position account data. */
export interface PositionData {
  whirlpool: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
  /** Position's last-recorded fee_growth_inside snapshot, token A (Q64.64 u128). */
  feeGrowthCheckpointA: bigint;
  /** Accrued fees owed to the position in token A (lamports). Non-zero only after update_fees_and_rewards or decrease_liquidity has run. */
  feeOwedA: bigint;
  /** Position's last-recorded fee_growth_inside snapshot, token B (Q64.64 u128). */
  feeGrowthCheckpointB: bigint;
  /** Accrued fees owed to the position in token B (micro-USDC). Same staleness rule as above. */
  feeOwedB: bigint;
}

// ---------------------------------------------------------------------------
// Account decoders
// ---------------------------------------------------------------------------

/**
 * Decode an Orca Whirlpool account from raw bytes.
 *
 * Byte offsets (validated against Orca on-chain layout):
 *   0-7:     discriminator
 *   8-39:    whirlpools_config (Pubkey)
 *   40:      whirlpool_bump (u8)
 *   41-42:   tick_spacing (u16 LE)
 *   43-44:   tick_spacing_seed (u16)
 *   45-46:   fee_rate (u16 LE)
 *   47-48:   protocol_fee_rate (u16)
 *   49-64:   liquidity (u128)
 *   65-80:   sqrt_price (u128 LE)
 *   81-84:   tick_current_index (i32 LE)
 *   ...
 *   101-132: token_mint_a (Pubkey)
 *   133-164: token_vault_a (Pubkey)
 *   165-180: fee_growth_global_a (u128 LE)
 *   181-212: token_mint_b (Pubkey)
 *   213-244: token_vault_b (Pubkey)
 *   245-260: fee_growth_global_b (u128 LE)
 */
export function decodeWhirlpoolAccount(data: Buffer): WhirlpoolData {
  if (data.length < 261) {
    throw new Error(
      `Whirlpool account data too short: ${data.length} < 261`,
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.whirlpool)) {
    throw new Error("Invalid Whirlpool discriminator");
  }

  const tickSpacing = data.readUInt16LE(41);
  const feeRate = data.readUInt16LE(45);

  const liquidity = readU128LE(data, 49);

  const sqrtPriceBuf = data.subarray(65, 81);
  const sqrtPrice =
    BigInt("0x" + Buffer.from(sqrtPriceBuf).reverse().toString("hex"));

  const tickCurrentIndex = data.readInt32LE(81);

  const tokenMintA = new PublicKey(data.subarray(101, 133));
  const tokenVaultA = new PublicKey(data.subarray(133, 165));
  const feeGrowthGlobalA = readU128LE(data, 165);
  const tokenMintB = new PublicKey(data.subarray(181, 213));
  const tokenVaultB = new PublicKey(data.subarray(213, 245));
  const feeGrowthGlobalB = readU128LE(data, 245);

  return {
    tickSpacing,
    sqrtPrice,
    tickCurrentIndex,
    tokenMintA,
    tokenMintB,
    tokenVaultA,
    tokenVaultB,
    feeRate,
    liquidity,
    feeGrowthGlobalA,
    feeGrowthGlobalB,
  };
}

/**
 * Decode an Orca Position account from raw bytes.
 *
 * Byte offsets (Orca Whirlpool Position struct, 216 bytes total):
 *   0-7:     discriminator
 *   8-39:    whirlpool (Pubkey)
 *   40-71:   position_mint (Pubkey)
 *   72-87:   liquidity (u128 LE)
 *   88-91:   tick_lower_index (i32 LE)
 *   92-95:   tick_upper_index (i32 LE)
 *   96-111:  fee_growth_checkpoint_a (u128 LE)
 *   112-119: fee_owed_a (u64 LE)                ← accrued fees, token A
 *   120-135: fee_growth_checkpoint_b (u128 LE)
 *   136-143: fee_owed_b (u64 LE)                ← accrued fees, token B
 *   144-215: reward_infos: [PositionRewardInfo; 3]
 */
export function decodePositionAccount(data: Buffer): PositionData {
  if (data.length < 144) {
    throw new Error(
      `Position account data too short: ${data.length} < 144`,
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.position)) {
    throw new Error("Invalid Position discriminator");
  }

  const whirlpool = new PublicKey(data.subarray(8, 40));
  const positionMint = new PublicKey(data.subarray(40, 72));

  const liquidityBuf = data.subarray(72, 88);
  const liquidity =
    BigInt("0x" + Buffer.from(liquidityBuf).reverse().toString("hex"));

  const tickLowerIndex = data.readInt32LE(88);
  const tickUpperIndex = data.readInt32LE(92);

  const feeGrowthCheckpointA = readU128LE(data, 96);
  const feeOwedA = data.readBigUInt64LE(112);
  const feeGrowthCheckpointB = readU128LE(data, 120);
  const feeOwedB = data.readBigUInt64LE(136);

  return {
    whirlpool,
    positionMint,
    liquidity,
    tickLowerIndex,
    tickUpperIndex,
    feeGrowthCheckpointA,
    feeOwedA,
    feeGrowthCheckpointB,
    feeOwedB,
  };
}

// ---------------------------------------------------------------------------
// TickArray decoder (fee_growth_outside per tick)
// ---------------------------------------------------------------------------

/**
 * A single Tick inside a TickArray — only the fields needed for fee-growth math.
 * Whirlpool Tick layout (113 bytes):
 *   0:       initialized (bool)
 *   1-16:    liquidity_net (i128)
 *   17-32:   liquidity_gross (u128)
 *   33-48:   fee_growth_outside_a (u128 LE)
 *   49-64:   fee_growth_outside_b (u128 LE)
 *   65-112:  reward_growths_outside: [u128; 3]
 */
const TICK_SIZE_BYTES = 113;
const TICKS_PER_ARRAY = 88;

/**
 * Read the `fee_growth_outside_{a,b}` for a specific tick from a TickArray account.
 *
 * Orca TickArray layout:
 *   0-7:     discriminator
 *   8-11:    start_tick_index (i32 LE)
 *   12-9955: ticks: [Tick; 88]  (each 113 bytes)
 *   9956+:   whirlpool (Pubkey)
 *
 * @param data             TickArray account bytes
 * @param tickIndex        Target tick index (must be aligned to tick_spacing)
 * @param tickArrayStartIx Start tick index of this array (from its account header)
 * @param tickSpacing      Pool's tick spacing
 * @returns Tuple of (fee_growth_outside_a, fee_growth_outside_b) as bigint Q64.64
 * @throws  If tickIndex is outside this array's range
 */
export function readTickFeeGrowthOutside(
  data: Buffer,
  tickIndex: number,
  tickArrayStartIx: number,
  tickSpacing: number,
): { feeGrowthOutsideA: bigint; feeGrowthOutsideB: bigint } {
  const arraySpanTicks = TICKS_PER_ARRAY * tickSpacing;
  if (
    tickIndex < tickArrayStartIx ||
    tickIndex >= tickArrayStartIx + arraySpanTicks
  ) {
    throw new Error(
      `Tick ${tickIndex} is outside array [${tickArrayStartIx}, ${
        tickArrayStartIx + arraySpanTicks
      })`,
    );
  }
  if ((tickIndex - tickArrayStartIx) % tickSpacing !== 0) {
    throw new Error(
      `Tick ${tickIndex} is not aligned to tickSpacing=${tickSpacing}`,
    );
  }
  const arrayPos = (tickIndex - tickArrayStartIx) / tickSpacing;
  const tickOffset = 8 + 4 + arrayPos * TICK_SIZE_BYTES;
  const feeGrowthOutsideA = readU128LE(data, tickOffset + 33);
  const feeGrowthOutsideB = readU128LE(data, tickOffset + 49);
  return { feeGrowthOutsideA, feeGrowthOutsideB };
}

// ---------------------------------------------------------------------------
// Little-endian u128 reader (native BigInt, portable across Node 20+)
// ---------------------------------------------------------------------------

function readU128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

// ---------------------------------------------------------------------------
// Concentrated Liquidity Math
// ---------------------------------------------------------------------------

/**
 * Convert a Q64.64 fixed-point sqrt price to a human-readable price.
 *
 * For SOL/USDC (decimalsA=9, decimalsB=6):
 *   price = (sqrtPrice / 2^64)^2 * 10^(9-6)
 */
export function sqrtPriceX64ToPrice(
  sqrtPriceX64: bigint,
  decimalsA: number = 9,
  decimalsB: number = 6,
): number {
  const sqrtPriceFloat = Number(sqrtPriceX64) / Number(Q64);
  const priceRaw = sqrtPriceFloat * sqrtPriceFloat;
  const decimalAdjust = Math.pow(10, decimalsA - decimalsB);
  return priceRaw * decimalAdjust;
}

/**
 * Convert a tick index to a Q64.64 sqrt price.
 *
 * sqrtPriceX64 = floor(sqrt(1.0001^tick) * 2^64)
 */
export function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
  return BigInt(Math.floor(sqrtPrice * Number(Q64)));
}

/** Align a tick to the nearest valid tick (multiple of tickSpacing). */
export function alignTick(
  tick: number,
  tickSpacing: number,
  direction: "up" | "down",
): number {
  if (direction === "down") {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

/**
 * Estimate liquidity (L) from desired token amounts for a concentrated position.
 *
 * For an in-range position (sqrtPriceLower < sqrtPriceCurrent < sqrtPriceUpper):
 *   L_a = amount_a * (sqrtCurrent * sqrtUpper) / (sqrtUpper - sqrtCurrent)
 *   L_b = amount_b / (sqrtCurrent - sqrtLower)
 *   L = min(L_a, L_b)
 *
 * For below-range (current <= lower): only token A contributes.
 * For above-range (current >= upper): only token B contributes.
 */
export function estimateLiquidity(
  amountA: bigint,
  amountB: bigint,
  sqrtPriceCurrent: bigint,
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
): bigint {
  if (sqrtPriceCurrent <= sqrtPriceLower) {
    if (sqrtPriceUpper <= sqrtPriceLower) return BigInt(0);
    return (
      (amountA * sqrtPriceLower * sqrtPriceUpper) /
      Q64 /
      (sqrtPriceUpper - sqrtPriceLower)
    );
  }
  if (sqrtPriceCurrent >= sqrtPriceUpper) {
    return (amountB * Q64) / (sqrtPriceUpper - sqrtPriceLower);
  }

  const liqA =
    (amountA * sqrtPriceCurrent * sqrtPriceUpper) /
    Q64 /
    (sqrtPriceUpper - sqrtPriceCurrent);

  const liqB = (amountB * Q64) / (sqrtPriceCurrent - sqrtPriceLower);

  return liqA < liqB ? liqA : liqB;
}

// ---------------------------------------------------------------------------
// PDA / ATA Derivation
// ---------------------------------------------------------------------------

/** Derive the Associated Token Account address for a given owner and mint. */
export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}
