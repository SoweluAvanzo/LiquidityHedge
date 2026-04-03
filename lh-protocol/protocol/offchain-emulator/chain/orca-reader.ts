/**
 * Orca Whirlpool account reader.
 * Wraps the decode functions from clients/cli/whirlpool-ix.ts with fetch logic.
 * Validates position PDA derivation, cross-references, and pool pair.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeWhirlpoolAccount,
  decodePositionAccount,
  deriveOrcaPositionPda,
  WhirlpoolData,
  PositionData,
} from "../../../clients/cli/whirlpool-ix";
import { WHIRLPOOL_PROGRAM_ID } from "../../../clients/cli/config";

export { WhirlpoolData, PositionData };

export async function readWhirlpool(
  connection: Connection,
  address: PublicKey
): Promise<WhirlpoolData> {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`Whirlpool not found: ${address.toBase58()}`);
  return decodeWhirlpoolAccount(Buffer.from(info.data));
}

export async function readOrcaPosition(
  connection: Connection,
  positionMint: PublicKey
): Promise<PositionData> {
  const [pda] = deriveOrcaPositionPda(positionMint);
  const info = await connection.getAccountInfo(pda);
  if (!info)
    throw new Error(`Orca Position PDA not found: ${pda.toBase58()}`);
  return decodePositionAccount(Buffer.from(info.data));
}

/**
 * Full Orca position validation — same checks as position_escrow/instructions.rs
 * production path (lines 76-133).
 */
export async function validateOrcaPosition(
  connection: Connection,
  positionMint: PublicKey,
  whirlpool: PublicKey,
  usdcMint: PublicKey
): Promise<{
  orcaPosition: PositionData;
  whirlpoolData: WhirlpoolData;
}> {
  // 1. Read and validate Orca Position account
  const [expectedPda] = deriveOrcaPositionPda(positionMint);
  const posInfo = await connection.getAccountInfo(expectedPda);
  if (!posInfo) throw new Error("Orca Position PDA not found");

  // Owner check: must be owned by Whirlpool program
  if (!posInfo.owner.equals(WHIRLPOOL_PROGRAM_ID)) {
    throw new Error(
      `Orca Position owner mismatch: expected ${WHIRLPOOL_PROGRAM_ID.toBase58()}, got ${posInfo.owner.toBase58()}`
    );
  }

  const orcaPosition = decodePositionAccount(Buffer.from(posInfo.data));

  // Cross-references
  if (!orcaPosition.positionMint.equals(positionMint)) {
    throw new Error("Position mint mismatch in Orca account");
  }
  if (!orcaPosition.whirlpool.equals(whirlpool)) {
    throw new Error("Whirlpool mismatch in Orca position");
  }

  // 2. Read and validate Whirlpool account
  const wpInfo = await connection.getAccountInfo(whirlpool);
  if (!wpInfo) throw new Error("Whirlpool account not found");

  if (!wpInfo.owner.equals(WHIRLPOOL_PROGRAM_ID)) {
    throw new Error(
      `Whirlpool owner mismatch: expected ${WHIRLPOOL_PROGRAM_ID.toBase58()}, got ${wpInfo.owner.toBase58()}`
    );
  }

  const whirlpoolData = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));

  // Verify pool pair: token_mint_b must be USDC
  if (!whirlpoolData.tokenMintB.equals(usdcMint)) {
    throw new Error(
      `Pool is not SOL/USDC: token_mint_b=${whirlpoolData.tokenMintB.toBase58()}, expected=${usdcMint.toBase58()}`
    );
  }

  return { orcaPosition, whirlpoolData };
}
