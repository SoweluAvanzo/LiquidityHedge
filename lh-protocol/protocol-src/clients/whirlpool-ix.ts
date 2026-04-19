/**
 * Raw Orca Whirlpool instruction builder using @solana/web3.js v1.
 *
 * Ported from the v1 implementation at lh-protocol/clients/cli/whirlpool-ix.ts
 * which was itself translated from the working Python reference at
 * test_deployment_v2/app/chain/whirlpool_instructions.py.
 *
 * Uses standard `open_position` (SPL Token), NOT Token2022, because
 * the LH protocol escrow uses anchor_spl::token::TokenAccount.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { WHIRLPOOL_PROGRAM_ID } from "./config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Q64 fixed-point factor (2^64) for sqrt price calculations. */
const Q64 = BigInt(1) << BigInt(64);

/** Orca instruction discriminators (Anchor 8-byte hashes). */
const DISCRIMINATORS = {
  openPosition: Buffer.from([135, 128, 47, 77, 15, 152, 240, 49]),
  increaseLiquidity: Buffer.from([46, 156, 243, 118, 13, 205, 251, 178]),
} as const;

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
}

/** Decoded on-chain Orca Position account data. */
export interface PositionData {
  whirlpool: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
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
 *   ...
 *   181-212: token_mint_b (Pubkey)
 *   213-244: token_vault_b (Pubkey)
 */
export function decodeWhirlpoolAccount(data: Buffer): WhirlpoolData {
  if (data.length < 245) {
    throw new Error(
      `Whirlpool account data too short: ${data.length} < 245`,
    );
  }

  // Validate discriminator
  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.whirlpool)) {
    throw new Error("Invalid Whirlpool discriminator");
  }

  const tickSpacing = data.readUInt16LE(41);
  const feeRate = data.readUInt16LE(45);

  // sqrt_price is u128 LE at offset 65
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

/**
 * Decode an Orca Position account from raw bytes.
 *
 * Byte offsets:
 *   0-7:   discriminator
 *   8-39:  whirlpool (Pubkey)
 *   40-71: position_mint (Pubkey)
 *   72-87: liquidity (u128 LE)
 *   88-91: tick_lower_index (i32 LE)
 *   92-95: tick_upper_index (i32 LE)
 */
export function decodePositionAccount(data: Buffer): PositionData {
  if (data.length < 96) {
    throw new Error(
      `Position account data too short: ${data.length} < 96`,
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

  return {
    whirlpool,
    positionMint,
    liquidity,
    tickLowerIndex,
    tickUpperIndex,
  };
}

// ---------------------------------------------------------------------------
// Concentrated Liquidity Math
// ---------------------------------------------------------------------------

/**
 * Convert a Q64.64 fixed-point sqrt price to a human-readable price.
 *
 * For SOL/USDC (decimalsA=9, decimalsB=6):
 *   price = (sqrtPrice / 2^64)^2 * 10^(9-6)
 *
 * @param sqrtPriceX64 - The Q64.64 sqrt price from the whirlpool account.
 * @param decimalsA    - Decimals of token A (default 9 for SOL).
 * @param decimalsB    - Decimals of token B (default 6 for USDC).
 * @returns Human-readable price (e.g. ~150.0 for SOL/USDC).
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
 *
 * @param tick - The tick index.
 * @returns The Q64.64 fixed-point sqrt price.
 */
export function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
  return BigInt(Math.floor(sqrtPrice * Number(Q64)));
}

/**
 * Align a tick to the nearest valid tick (multiple of tickSpacing).
 *
 * @param tick        - The raw tick index.
 * @param tickSpacing - The whirlpool's tick spacing.
 * @param direction   - "down" for floor, "up" for ceil.
 * @returns The aligned tick index.
 */
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
 *
 * All sqrt prices are Q64.64. Amounts are in raw token units (lamports / micro-USDC).
 *
 * @param amountA          - Raw amount of token A (e.g. lamports of SOL).
 * @param amountB          - Raw amount of token B (e.g. micro-USDC).
 * @param sqrtPriceCurrent - Current pool sqrt price (Q64.64).
 * @param sqrtPriceLower   - Lower tick sqrt price (Q64.64).
 * @param sqrtPriceUpper   - Upper tick sqrt price (Q64.64).
 * @returns Estimated liquidity value.
 */
export function estimateLiquidity(
  amountA: bigint,
  amountB: bigint,
  sqrtPriceCurrent: bigint,
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
): bigint {
  if (sqrtPriceCurrent <= sqrtPriceLower) {
    // Below range: all token A
    if (sqrtPriceUpper <= sqrtPriceLower) return BigInt(0);
    return (
      (amountA * sqrtPriceLower * sqrtPriceUpper) /
      Q64 /
      (sqrtPriceUpper - sqrtPriceLower)
    );
  }
  if (sqrtPriceCurrent >= sqrtPriceUpper) {
    // Above range: all token B
    return (amountB * Q64) / (sqrtPriceUpper - sqrtPriceLower);
  }

  // In range: take the minimum of both estimates
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

/**
 * Derive the Associated Token Account address for a given owner and mint.
 *
 * @param owner - The wallet that owns the ATA.
 * @param mint  - The SPL token mint.
 * @returns The derived ATA public key.
 */
export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

// ---------------------------------------------------------------------------
// Instruction Builders
// ---------------------------------------------------------------------------

/**
 * Build the `open_position` instruction (standard SPL Token variant).
 *
 * Data layout: discriminator (8) + bump (1) + tickLower (i32 LE) + tickUpper (i32 LE) = 17 bytes
 *
 * Account order (from Whirlpool program):
 *   0. funder            (signer, writable)
 *   1. owner             (not signer, not writable)
 *   2. position PDA      (writable)
 *   3. position_mint     (signer, writable) -- new keypair
 *   4. position_token_account / owner ATA (writable)
 *   5. whirlpool         (not writable)
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
  const data = Buffer.alloc(17);
  DISCRIMINATORS.openPosition.copy(data, 0);
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
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
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
 * Data layout: discriminator (8) + liquidity_amount (u128 LE, 16) +
 *              token_max_a (u64 LE, 8) + token_max_b (u64 LE, 8) = 40 bytes
 *
 * Account order:
 *    0. whirlpool              (writable)
 *    1. token_program
 *    2. position_authority     (signer)
 *    3. position PDA           (writable)
 *    4. position_token_account
 *    5. token_owner_account_a  (writable) -- owner's WSOL ATA
 *    6. token_owner_account_b  (writable) -- owner's USDC ATA
 *    7. token_vault_a          (writable) -- pool's SOL vault
 *    8. token_vault_b          (writable) -- pool's USDC vault
 *    9. tick_array_lower       (writable)
 *   10. tick_array_upper       (writable)
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
  DISCRIMINATORS.increaseLiquidity.copy(data, 0);

  // liquidity_amount as u128 LE (16 bytes)
  let liq = params.liquidityAmount;
  for (let i = 0; i < 16; i++) {
    data[8 + i] = Number(liq & BigInt(0xff));
    liq >>= BigInt(8);
  }

  // token_max_a as u64 LE (8 bytes)
  let maxA = params.tokenMaxA;
  for (let i = 0; i < 8; i++) {
    data[24 + i] = Number(maxA & BigInt(0xff));
    maxA >>= BigInt(8);
  }

  // token_max_b as u64 LE (8 bytes)
  let maxB = params.tokenMaxB;
  for (let i = 0; i < 8; i++) {
    data[32 + i] = Number(maxB & BigInt(0xff));
    maxB >>= BigInt(8);
  }

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

// ---------------------------------------------------------------------------
// WSOL Helpers
// ---------------------------------------------------------------------------

/**
 * Build the instructions needed to wrap SOL into a WSOL ATA.
 *
 * Returns three instructions:
 *   1. Create the WSOL ATA (via Associated Token Program)
 *   2. Transfer lamports into the ATA (via System Program)
 *   3. Sync the native balance (via SPL Token syncNative)
 *
 * @param owner    - The wallet wrapping SOL.
 * @param wsolAta  - The WSOL ATA address (derive with `deriveAta(owner, SOL_MINT)`).
 * @param lamports - Amount of lamports to wrap.
 * @returns Array of three TransactionInstructions.
 */
export function buildWrapSolIxs(
  owner: PublicKey,
  wsolAta: PublicKey,
  lamports: bigint,
): TransactionInstruction[] {
  const SOL_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );

  // 1. Create ATA (idempotent via ATA program's create-idempotent ix)
  const createAtaIx = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: SOL_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });

  // 2. Transfer lamports into the ATA
  const transferIx = SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: wsolAta,
    lamports: lamports,
  });

  // 3. Sync native balance so the token account reflects the deposited SOL
  const syncIx = createSyncNativeInstruction(wsolAta);

  return [createAtaIx, transferIx, syncIx];
}

/**
 * Build an instruction to unwrap WSOL by closing the ATA.
 *
 * Remaining SOL lamports are returned to the owner.
 *
 * @param wsolAta - The WSOL ATA to close.
 * @param owner   - The wallet receiving reclaimed lamports.
 * @returns A single TransactionInstruction.
 */
export function buildUnwrapSolIx(
  wsolAta: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  return createCloseAccountInstruction(wsolAta, owner, owner);
}
