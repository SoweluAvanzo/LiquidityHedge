/**
 * Shared utilities for CLI scripts: ATA creation, WSOL wrapping, mint helpers.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA_PROGRAM_ID,
} from "@solana/spl-token";

// ─── ATA Helpers ─────────────────────────────────────────────────────

/**
 * Get or create an Associated Token Account. Returns the ATA address.
 * If allowOwnerOffCurve is true, the owner can be a PDA.
 */
export async function getOrCreateAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve: boolean = false
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    SPL_TOKEN_PROGRAM_ID,
    SPL_ATA_PROGRAM_ID
  );

  try {
    await getAccount(connection, ata);
    return ata; // Already exists
  } catch {
    // Create it
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      SPL_TOKEN_PROGRAM_ID,
      SPL_ATA_PROGRAM_ID
    );
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer]);
    return ata;
  }
}

/**
 * Build the instruction to create an ATA (does NOT check existence).
 */
export function buildCreateAtaIx(
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve: boolean = false
): { ix: TransactionInstruction; ata: PublicKey } {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    SPL_TOKEN_PROGRAM_ID,
    SPL_ATA_PROGRAM_ID
  );
  const ix = createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint,
    SPL_TOKEN_PROGRAM_ID,
    SPL_ATA_PROGRAM_ID
  );
  return { ix, ata };
}

// ─── WSOL Helpers ────────────────────────────────────────────────────

/**
 * Build instructions to wrap SOL into a WSOL token account.
 * Returns [createAta, transfer, syncNative] instructions.
 * The caller must include these BEFORE any instruction that uses the WSOL ATA.
 */
export function buildWrapSolIxs(
  payer: PublicKey,
  wsolAta: PublicKey,
  lamports: number
): TransactionInstruction[] {
  const transferIx = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: wsolAta,
    lamports,
  });
  const syncIx = createSyncNativeInstruction(wsolAta);
  return [transferIx, syncIx];
}

/**
 * Build instruction to close a WSOL account (unwrap remaining SOL back to wallet).
 */
export function buildUnwrapSolIx(
  wsolAta: PublicKey,
  owner: PublicKey
): TransactionInstruction {
  return createCloseAccountInstruction(
    wsolAta,
    owner, // destination for remaining SOL
    owner // authority
  );
}

// ─── Mint Helpers ────────────────────────────────────────────────────

/**
 * Create a new mint with a given authority. Used for certificate NFT mints.
 * Returns { mintKeypair, instructions }.
 * The caller must include mintKeypair as a signer.
 */
export async function buildCreateMintIxs(
  connection: Connection,
  payer: PublicKey,
  mintAuthority: PublicKey,
  decimals: number = 0
): Promise<{ mintKeypair: Keypair; instructions: TransactionInstruction[] }> {
  const mintKeypair = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(82); // Mint account size

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: mintKeypair.publicKey,
    lamports,
    space: 82,
    programId: SPL_TOKEN_PROGRAM_ID,
  });

  const initMintIx = createInitializeMint2Instruction(
    mintKeypair.publicKey,
    decimals,
    mintAuthority,
    null, // no freeze authority
    SPL_TOKEN_PROGRAM_ID
  );

  return {
    mintKeypair,
    instructions: [createAccountIx, initMintIx],
  };
}

// ─── Transaction Helpers ─────────────────────────────────────────────

/**
 * Send a transaction with retry on blockhash expiry.
 */
export async function sendTxWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  maxRetries: number = 2
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: "confirmed",
      });
      return sig;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (
        msg.includes("blockhash") &&
        msg.includes("not found") &&
        attempt < maxRetries
      ) {
        console.log(
          `  Blockhash expired, retrying (${attempt + 1}/${maxRetries})...`
        );
        // Refresh blockhash
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

// ─── Formatting ──────────────────────────────────────────────────────

/**
 * Format USDC amount from micro-units (6 decimals) to human-readable.
 */
export function formatUsdc(microUsdc: number | bigint): string {
  return (Number(microUsdc) / 1_000_000).toFixed(6);
}

/**
 * Format SOL amount from lamports to human-readable.
 */
export function formatSol(lamports: number | bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(9);
}
