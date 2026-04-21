/**
 * Orca Whirlpool instruction builders (write-side of the Orca integration).
 *
 * Paired with `market-data/decoder.ts`, which owns the read-side
 * (account decoders, CL math). This file contains only the
 * transaction-producing surface area: open_position, increase/decrease
 * liquidity, collect fees, close position, WSOL wrap/unwrap.
 *
 * Ported from `lh-protocol/clients/whirlpool-ix.ts`.
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
import { WHIRLPOOL_PROGRAM_ID } from "../config/chain";

// ---------------------------------------------------------------------------
// Orca instruction discriminators (Anchor 8-byte hashes = sha256("global:<name>")[:8])
// ---------------------------------------------------------------------------

const DISCRIMINATORS = {
  openPosition: Buffer.from([135, 128, 47, 77, 15, 152, 240, 49]),
  increaseLiquidity: Buffer.from([46, 156, 243, 118, 13, 205, 251, 178]),
  decreaseLiquidity: Buffer.from([160, 38, 208, 111, 104, 91, 44, 1]),
  updateFeesAndRewards: Buffer.from([154, 230, 250, 13, 236, 209, 75, 223]),
  collectFees: Buffer.from([164, 152, 207, 99, 30, 186, 19, 182]),
  closePosition: Buffer.from([123, 134, 81, 0, 49, 68, 98, 98]),
} as const;

// ---------------------------------------------------------------------------
// Instruction builders
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

  let liq = params.liquidityAmount;
  for (let i = 0; i < 16; i++) {
    data[8 + i] = Number(liq & BigInt(0xff));
    liq >>= BigInt(8);
  }

  let maxA = params.tokenMaxA;
  for (let i = 0; i < 8; i++) {
    data[24 + i] = Number(maxA & BigInt(0xff));
    maxA >>= BigInt(8);
  }

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

/**
 * Build the `decrease_liquidity` instruction.
 *
 * Data layout: discriminator (8) + liquidity_amount (u128 LE, 16) +
 *              token_min_a (u64 LE, 8) + token_min_b (u64 LE, 8) = 40 bytes
 *
 * Accounts mirror `increase_liquidity` exactly.
 */
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
  DISCRIMINATORS.decreaseLiquidity.copy(data, 0);

  let liq = params.liquidityAmount;
  for (let i = 0; i < 16; i++) {
    data[8 + i] = Number(liq & BigInt(0xff));
    liq >>= BigInt(8);
  }

  let minA = params.tokenMinA;
  for (let i = 0; i < 8; i++) {
    data[24 + i] = Number(minA & BigInt(0xff));
    minA >>= BigInt(8);
  }

  let minB = params.tokenMinB;
  for (let i = 0; i < 8; i++) {
    data[32 + i] = Number(minB & BigInt(0xff));
    minB >>= BigInt(8);
  }

  const keys: AccountMeta[] = [
    { pubkey: params.whirlpool, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: params.positionAuthority, isSigner: true, isWritable: false },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    {
      pubkey: params.positionTokenAccount,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: params.tokenOwnerAccountA, isSigner: false, isWritable: true },
    { pubkey: params.tokenOwnerAccountB, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: params.tickArrayLower, isSigner: false, isWritable: true },
    { pubkey: params.tickArrayUpper, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the `update_fees_and_rewards` instruction.
 *
 * Anchor's internal bookkeeping is lazy: accrued fees aren't reflected
 * in `position.fee_owed_{a,b}` until this ix (or `decrease_liquidity`,
 * which calls it internally) runs. Use this to refresh the position
 * account before *reading* `fee_owed_{a,b}` if you want a current
 * snapshot without also removing liquidity.
 */
export function buildUpdateFeesAndRewardsIx(params: {
  whirlpool: PublicKey;
  positionPda: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
}): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.updateFeesAndRewards);

  const keys: AccountMeta[] = [
    { pubkey: params.whirlpool, isSigner: false, isWritable: true },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    { pubkey: params.tickArrayLower, isSigner: false, isWritable: false },
    { pubkey: params.tickArrayUpper, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the `collect_fees` instruction. Must be called before
 * `close_position` if the position has accrued any fees.
 */
export function buildCollectFeesIx(params: {
  whirlpool: PublicKey;
  positionAuthority: PublicKey;
  positionPda: PublicKey;
  positionTokenAccount: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenVaultA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultB: PublicKey;
}): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.collectFees);

  const keys: AccountMeta[] = [
    { pubkey: params.whirlpool, isSigner: false, isWritable: false },
    { pubkey: params.positionAuthority, isSigner: true, isWritable: false },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    {
      pubkey: params.positionTokenAccount,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: params.tokenOwnerAccountA, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: params.tokenOwnerAccountB, isSigner: false, isWritable: true },
    { pubkey: params.tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the `close_position` instruction. Requires liquidity == 0 AND
 * fee_owed_{a,b} == 0 AND all rewards owed == 0.
 */
export function buildClosePositionIx(params: {
  positionAuthority: PublicKey;
  receiver: PublicKey;
  positionPda: PublicKey;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
}): TransactionInstruction {
  const data = Buffer.from(DISCRIMINATORS.closePosition);

  const keys: AccountMeta[] = [
    { pubkey: params.positionAuthority, isSigner: true, isWritable: false },
    { pubkey: params.receiver, isSigner: false, isWritable: true },
    { pubkey: params.positionPda, isSigner: false, isWritable: true },
    { pubkey: params.positionMint, isSigner: false, isWritable: true },
    {
      pubkey: params.positionTokenAccount,
      isSigner: false,
      isWritable: true,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// WSOL helpers
// ---------------------------------------------------------------------------

/**
 * Build the instructions needed to wrap SOL into a WSOL ATA.
 *
 * Returns three instructions: create ATA, transfer lamports, sync native.
 */
export function buildWrapSolIxs(
  owner: PublicKey,
  wsolAta: PublicKey,
  lamports: bigint,
): TransactionInstruction[] {
  const SOL_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );

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

  const transferIx = SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: wsolAta,
    lamports: lamports,
  });

  const syncIx = createSyncNativeInstruction(wsolAta);

  return [createAtaIx, transferIx, syncIx];
}

/** Build an instruction to unwrap WSOL by closing the ATA. */
export function buildUnwrapSolIx(
  wsolAta: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  return createCloseAccountInstruction(wsolAta, owner, owner);
}
