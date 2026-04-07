/**
 * Raw Orca Whirlpool instruction builder using @solana/web3.js v1.
 *
 * Translated from the working Python reference at
 * test_deployment_v2/app/chain/whirlpool_instructions.py.
 *
 * Uses standard `open_position` (SPL Token), NOT Token2022, because
 * the LH protocol escrow uses anchor_spl::token::TokenAccount.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  WHIRLPOOL_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  RENT_SYSVAR_ID,
  ORCA_DISCRIMINATORS,
  ORCA_ACCOUNT_DISCRIMINATORS,
  TICK_ARRAY_SIZE,
  Q64,
} from "./config";

// ─── PDA Derivation ──────────────────────────────────────────────────

/**
 * Derive the Orca Position PDA from a position mint.
 * Seeds: ["position", position_mint] under WHIRLPOOL_PROGRAM_ID.
 */
export function deriveOrcaPositionPda(
  positionMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.toBuffer()],
    WHIRLPOOL_PROGRAM_ID
  );
}

/**
 * Derive a tick array PDA.
 * Seeds: ["tick_array", whirlpool, start_tick_index_string] under WHIRLPOOL_PROGRAM_ID.
 */
export function deriveTickArrayPda(
  whirlpool: PublicKey,
  startTickIndex: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("tick_array"),
      whirlpool.toBuffer(),
      Buffer.from(startTickIndex.toString()),
    ],
    WHIRLPOOL_PROGRAM_ID
  );
}

/**
 * Get the start tick index for the tick array containing `tick`.
 * Uses floor division: startIndex = floor(tick / (tickSpacing * TICK_ARRAY_SIZE)) * (tickSpacing * TICK_ARRAY_SIZE)
 */
export function getTickArrayStartIndex(
  tick: number,
  tickSpacing: number
): number {
  const ticksPerArray = tickSpacing * TICK_ARRAY_SIZE;
  // Math.floor already does floor-toward-negative-infinity in JS
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

/**
 * Derive the ATA (Associated Token Account) for a given owner + mint.
 */
export function deriveAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

// ─── Whirlpool Account Decoding ──────────────────────────────────────

export interface WhirlpoolData {
  tickSpacing: number;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  feeRate: number;
}

/**
 * Decode an Orca Whirlpool account from raw bytes.
 * Layout validated against test_deployment_v2/app/chain/orca_client.py.
 *
 * Offsets (from on-chain orca.rs):
 *   0-7:     discriminator
 *   8-39:    whirlpools_config (Pubkey)
 *   40:      whirlpool_bump (u8[1])
 *   41-42:   tick_spacing (u16)
 *   43-44:   tick_spacing_seed (u16[2])
 *   45-46:   fee_rate (u16)
 *   47-48:   protocol_fee_rate (u16)
 *   49-64:   liquidity (u128)
 *   65-80:   sqrt_price (u128)
 *   81-84:   tick_current_index (i32)
 *   ...
 *   101-132: token_mint_a (Pubkey)
 *   133-164: token_vault_a (Pubkey)
 *   ...
 *   181-212: token_mint_b (Pubkey)
 *   213-244: token_vault_b (Pubkey)
 */
export function decodeWhirlpoolAccount(data: Buffer): WhirlpoolData {
  if (data.length < 245) {
    throw new Error(
      `Whirlpool account data too short: ${data.length} < 245`
    );
  }

  // Validate discriminator
  const disc = data.subarray(0, 8);
  if (!disc.equals(ORCA_ACCOUNT_DISCRIMINATORS.whirlpool)) {
    throw new Error("Invalid Whirlpool discriminator");
  }

  const tickSpacing = data.readUInt16LE(41);
  const feeRate = data.readUInt16LE(45);

  // sqrt_price is u128 at offset 65
  const sqrtPriceBuf = data.subarray(65, 81);
  const sqrtPrice =
    BigInt("0x" + Buffer.from(sqrtPriceBuf).reverse().toString("hex"));

  const tickCurrentIndex = data.readInt32LE(81);

  const tokenMintA = new PublicKey(data.subarray(101, 133));
  const tokenVaultA = new PublicKey(data.subarray(133, 165));
  const tokenMintB = new PublicKey(data.subarray(181, 213));
  const tokenVaultB = new PublicKey(data.subarray(213, 245));

  return {
    tickSpacing,
    sqrtPrice,
    tickCurrentIndex,
    tokenMintA,
    tokenMintB,
    tokenVaultA,
    tokenVaultB,
    feeRate,
  };
}

// ─── Position Account Decoding ───────────────────────────────────────

export interface PositionData {
  whirlpool: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
}

/**
 * Decode an Orca Position account from raw bytes.
 * Offsets from on-chain orca.rs:
 *   0-7:   discriminator
 *   8-39:  whirlpool (Pubkey)
 *   40-71: position_mint (Pubkey)
 *   72-87: liquidity (u128)
 *   88-91: tick_lower_index (i32)
 *   92-95: tick_upper_index (i32)
 */
export function decodePositionAccount(data: Buffer): PositionData {
  if (data.length < 96) {
    throw new Error(
      `Position account data too short: ${data.length} < 96`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ORCA_ACCOUNT_DISCRIMINATORS.position)) {
    throw new Error("Invalid Position discriminator");
  }

  const whirlpool = new PublicKey(data.subarray(8, 40));
  const positionMint = new PublicKey(data.subarray(40, 72));

  const liquidityBuf = data.subarray(72, 88);
  const liquidity =
    BigInt("0x" + Buffer.from(liquidityBuf).reverse().toString("hex"));

  const tickLowerIndex = data.readInt32LE(88);
  const tickUpperIndex = data.readInt32LE(92);

  return {
    whirlpool,
    positionMint,
    liquidity,
    tickLowerIndex,
    tickUpperIndex,
  };
}

// ─── Concentrated Liquidity Math ─────────────────────────────────────

/**
 * Convert a tick to sqrtPriceX64 (Q64.64 fixed-point).
 * sqrtPriceX64 = floor(sqrt(1.0001^tick) * 2^64)
 */
export function tickToSqrtPriceX64(tick: number): bigint {
  // Use floating-point for sqrt(1.0001^tick), then scale to X64
  const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
  // Convert to bigint Q64
  return BigInt(Math.floor(sqrtPrice * Number(Q64)));
}

/**
 * Convert sqrtPriceX64 to human-readable price.
 * For SOL/USDC: price = (sqrtPrice / 2^64)^2 * 10^(9-6) = (sqrtPrice/2^64)^2 * 1000
 */
export function sqrtPriceX64ToPrice(
  sqrtPriceX64: bigint,
  decimalsA: number = 9,
  decimalsB: number = 6
): number {
  const sqrtPriceFloat = Number(sqrtPriceX64) / Number(Q64);
  const priceRaw = sqrtPriceFloat * sqrtPriceFloat;
  const decimalAdjust = Math.pow(10, decimalsA - decimalsB);
  return priceRaw * decimalAdjust;
}

/**
 * Convert a human-readable price to sqrtPriceX64.
 * Inverse of sqrtPriceX64ToPrice.
 */
export function priceToSqrtPriceX64(
  price: number,
  decimalsA: number = 9,
  decimalsB: number = 6
): bigint {
  const decimalAdjust = Math.pow(10, decimalsA - decimalsB);
  const sqrtPrice = Math.sqrt(price / decimalAdjust);
  return BigInt(Math.floor(sqrtPrice * Number(Q64)));
}

/**
 * Estimate liquidity from desired token amounts for a concentrated position.
 *
 * For in-range position (sqrtPriceLower < sqrtPriceCurrent < sqrtPriceUpper):
 *   L_a = amount_a * (sqrtCurrent * sqrtUpper) / (sqrtUpper - sqrtCurrent)
 *   L_b = amount_b / (sqrtCurrent - sqrtLower)
 *   L = min(L_a, L_b)
 */
export function estimateLiquidity(
  amountA: bigint,
  amountB: bigint,
  sqrtPriceCurrent: bigint,
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint
): bigint {
  if (sqrtPriceCurrent <= sqrtPriceLower) {
    // All token A (below range)
    if (sqrtPriceUpper <= sqrtPriceLower) return BigInt(0);
    return (
      (amountA * sqrtPriceLower * sqrtPriceUpper) /
      Q64 /
      (sqrtPriceUpper - sqrtPriceLower)
    );
  }
  if (sqrtPriceCurrent >= sqrtPriceUpper) {
    // All token B (above range)
    return (amountB * Q64) / (sqrtPriceUpper - sqrtPriceLower);
  }

  // In range — take the minimum
  const liqA =
    (amountA * sqrtPriceCurrent * sqrtPriceUpper) /
    Q64 /
    (sqrtPriceUpper - sqrtPriceCurrent);

  const liqB = (amountB * Q64) / (sqrtPriceCurrent - sqrtPriceLower);

  return liqA < liqB ? liqA : liqB;
}

/**
 * Align a tick to the nearest valid tick (multiple of tickSpacing).
 * direction: 'down' = floor, 'up' = ceil
 */
export function alignTick(
  tick: number,
  tickSpacing: number,
  direction: "down" | "up" = "down"
): number {
  if (direction === "down") {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

// ─── Instruction Builders ────────────────────────────────────────────

/**
 * Build the `open_position` instruction (standard SPL Token, NOT Token2022).
 *
 * Account order (from Whirlpool program):
 *   0. funder (signer, writable)
 *   1. owner (not signer, not writable)
 *   2. position PDA (writable)
 *   3. position_mint (signer, writable) — new keypair
 *   4. position_token_account / owner ATA (writable)
 *   5. whirlpool (not writable)
 *   6. token_program
 *   7. system_program
 *   8. rent
 *   9. associated_token_program
 */
export function buildOpenPositionIx(params: {
  funder: PublicKey;
  owner: PublicKey;
  positionPda: PublicKey;
  positionBump: number;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
  whirlpool: PublicKey;
  tickLowerIndex: number;
  tickUpperIndex: number;
}): TransactionInstruction {
  // Data: discriminator(8) + bump(1) + tick_lower(i32 LE) + tick_upper(i32 LE) = 17 bytes
  const data = Buffer.alloc(17);
  ORCA_DISCRIMINATORS.openPosition.copy(data, 0);
  data.writeUInt8(params.positionBump, 8);
  data.writeInt32LE(params.tickLowerIndex, 9);
  data.writeInt32LE(params.tickUpperIndex, 13);

  const keys: AccountMeta[] = [
    { pubkey: params.funder, isSigner: true, isWritable: true },
    { pubkey: params.owner, isSigner: false, isWritable: false },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    { pubkey: params.positionMint, isSigner: true, isWritable: true },
    {
      pubkey: params.positionTokenAccount,
      isSigner: false,
      isWritable: true,
    },
    { pubkey: params.whirlpool, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: RENT_SYSVAR_ID, isSigner: false, isWritable: false },
    {
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
  ];

  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the `increase_liquidity` instruction.
 *
 * Data: discriminator(8) + liquidity_amount(u128 LE, 16) + token_max_a(u64 LE, 8) + token_max_b(u64 LE, 8) = 40 bytes
 *
 * Account order:
 *   0. whirlpool (writable)
 *   1. token_program
 *   2. position_authority (signer)
 *   3. position PDA (writable)
 *   4. position_token_account
 *   5. token_owner_account_a (writable) — WSOL ATA
 *   6. token_owner_account_b (writable) — USDC ATA
 *   7. token_vault_a (writable) — pool's SOL vault
 *   8. token_vault_b (writable) — pool's USDC vault
 *   9. tick_array_lower (writable)
 *  10. tick_array_upper (writable)
 */
export function buildIncreaseLiquidityIx(params: {
  whirlpool: PublicKey;
  positionAuthority: PublicKey;
  positionPda: PublicKey;
  positionTokenAccount: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  liquidityAmount: bigint;
  tokenMaxA: bigint;
  tokenMaxB: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(40);
  ORCA_DISCRIMINATORS.increaseLiquidity.copy(data, 0);

  // liquidity_amount as u128 LE (16 bytes)
  const liqBuf = Buffer.alloc(16);
  let liq = params.liquidityAmount;
  for (let i = 0; i < 16; i++) {
    liqBuf[i] = Number(liq & BigInt(0xff));
    liq >>= BigInt(8);
  }
  liqBuf.copy(data, 8);

  // token_max_a as u64 LE
  const maxABn = new BN(params.tokenMaxA.toString());
  maxABn.toArrayLike(Buffer, "le", 8).copy(data, 24);

  // token_max_b as u64 LE
  const maxBBn = new BN(params.tokenMaxB.toString());
  maxBBn.toArrayLike(Buffer, "le", 8).copy(data, 32);

  const keys: AccountMeta[] = [
    { pubkey: params.whirlpool, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: params.positionAuthority,
      isSigner: true,
      isWritable: false,
    },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    {
      pubkey: params.positionTokenAccount,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: params.tokenOwnerAccountA,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: params.tokenOwnerAccountB,
      isSigner: false,
      isWritable: true,
    },
    { pubkey: params.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultB, isSigner: false, isWritable: true },
    {
      pubkey: params.tickArrayLower,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: params.tickArrayUpper,
      isSigner: false,
      isWritable: true,
    },
  ];

  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys,
    data,
  });
}

// ─── Decrease Liquidity ─────────────────────────────────────────────

export function buildDecreaseLiquidityIx(params: {
  whirlpool: PublicKey;
  positionAuthority: PublicKey;
  positionPda: PublicKey;
  positionTokenAccount: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  liquidityAmount: bigint;
  tokenMinA: bigint;
  tokenMinB: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(40);
  ORCA_DISCRIMINATORS.decreaseLiquidity.copy(data, 0);
  const liqBuf = Buffer.alloc(16);
  let liq = params.liquidityAmount;
  for (let i = 0; i < 16; i++) {
    liqBuf[i] = Number(liq & BigInt(0xff));
    liq >>= BigInt(8);
  }
  liqBuf.copy(data, 8);
  new BN(params.tokenMinA.toString()).toArrayLike(Buffer, "le", 8).copy(data, 24);
  new BN(params.tokenMinB.toString()).toArrayLike(Buffer, "le", 8).copy(data, 32);

  const keys: AccountMeta[] = [
    { pubkey: params.whirlpool, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: params.positionAuthority, isSigner: true, isWritable: false },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    { pubkey: params.positionTokenAccount, isSigner: false, isWritable: false },
    { pubkey: params.tokenOwnerAccountA, isSigner: false, isWritable: true },
    { pubkey: params.tokenOwnerAccountB, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: params.tickArrayLower, isSigner: false, isWritable: true },
    { pubkey: params.tickArrayUpper, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM_ID, keys, data });
}

// ─── Collect Fees ───────────────────────────────────────────────────

export function buildCollectFeesIx(params: {
  whirlpool: PublicKey;
  positionAuthority: PublicKey;
  positionPda: PublicKey;
  positionTokenAccount: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(8);
  ORCA_DISCRIMINATORS.collectFees.copy(data, 0);
  // Account order: owner_a, vault_a, owner_b, vault_b (interleaved, not grouped)
  const keys: AccountMeta[] = [
    { pubkey: params.whirlpool, isSigner: false, isWritable: false },
    { pubkey: params.positionAuthority, isSigner: true, isWritable: false },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    { pubkey: params.positionTokenAccount, isSigner: false, isWritable: false },
    { pubkey: params.tokenOwnerAccountA, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: params.tokenOwnerAccountB, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM_ID, keys, data });
}

// ─── Close Position ─────────────────────────────────────────────────

export function buildClosePositionIx(params: {
  positionAuthority: PublicKey;
  receiver: PublicKey;
  positionPda: PublicKey;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(8);
  ORCA_DISCRIMINATORS.closePosition.copy(data, 0);
  const keys: AccountMeta[] = [
    { pubkey: params.positionAuthority, isSigner: true, isWritable: false },
    { pubkey: params.receiver, isSigner: false, isWritable: true },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    { pubkey: params.positionMint, isSigner: false, isWritable: true },
    { pubkey: params.positionTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM_ID, keys, data });
}
