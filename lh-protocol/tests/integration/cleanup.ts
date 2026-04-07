/**
 * Cleanup and recovery module for integration tests.
 * Tracks test state and provides recovery if the test crashes mid-way.
 */

import {
  Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import { createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { CleanupState } from "./types";
import {
  deriveOrcaPositionPda,
  decodePositionAccount,
  deriveTickArrayPda,
  getTickArrayStartIndex,
  buildDecreaseLiquidityIx,
  buildCollectFeesIx,
  buildClosePositionIx,
  WhirlpoolData,
} from "../../clients/cli/whirlpool-ix";
import {
  getOrCreateAta,
  buildWrapSolIxs,
  buildUnwrapSolIx,
  sendTxWithRetry,
} from "../../clients/cli/utils";
import { SOL_MINT, WHIRLPOOL_ADDRESS } from "../../clients/cli/config";

export function initCleanupState(dataDir: string): CleanupState {
  return {
    dataDir,
    positionMint: null,
    positionOpen: false,
    nftInVault: false,
    positionRegistered: false,
    certActive: false,
    liquidity: null,
    tickLower: null,
    tickUpper: null,
  };
}

export function saveCleanupState(state: CleanupState): void {
  const filePath = path.join(state.dataDir, "cleanup-state.json");
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function loadCleanupState(dataDir: string): CleanupState | null {
  const filePath = path.join(dataDir, "cleanup-state.json");
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Close an Orca position: decrease liquidity to 0, collect fees, close position.
 */
export async function closeOrcaPosition(
  connection: Connection,
  owner: Keypair,
  positionMint: PublicKey,
  _wp: WhirlpoolData,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
): Promise<void> {
  // Always read fresh Whirlpool data to get current vault addresses
  const { decodeWhirlpoolAccount } = await import("../../clients/cli/whirlpool-ix");
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found for close");
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));

  const [orcaPositionPda] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = getAssociatedTokenAddressSync(positionMint, owner.publicKey);
  const wsolAta = await getOrCreateAta(connection, owner, SOL_MINT, owner.publicKey);
  const usdcAta = getAssociatedTokenAddressSync(wp.tokenMintB, owner.publicKey);

  const lowerStart = getTickArrayStartIndex(tickLower, wp.tickSpacing);
  const upperStart = getTickArrayStartIndex(tickUpper, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, lowerStart);
  const [tickArrayUpper] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, upperStart);

  const commonParams = {
    whirlpool: WHIRLPOOL_ADDRESS,
    positionAuthority: owner.publicKey,
    positionPda: orcaPositionPda,
    positionTokenAccount: ownerPositionAta,
    tokenOwnerAccountA: wsolAta,
    tokenOwnerAccountB: usdcAta,
    tokenVaultA: wp.tokenVaultA,
    tokenVaultB: wp.tokenVaultB,
  };

  // Decrease all liquidity
  if (liquidity > BigInt(0)) {
    const tx1 = new Transaction();
    tx1.add(...buildWrapSolIxs(owner.publicKey, wsolAta, 0)); // ensure WSOL ATA exists
    tx1.add(buildDecreaseLiquidityIx({
      ...commonParams,
      tickArrayLower,
      tickArrayUpper,
      liquidityAmount: liquidity,
      tokenMinA: BigInt(0),
      tokenMinB: BigInt(0),
    }));
    tx1.add(buildCollectFeesIx(commonParams));
    tx1.add(buildUnwrapSolIx(wsolAta, owner.publicKey));
    await sendTxWithRetry(connection, tx1, [owner]);
  }

  // Close position
  const tx2 = new Transaction();
  tx2.add(buildClosePositionIx({
    positionAuthority: owner.publicKey,
    receiver: owner.publicKey,
    positionPda: orcaPositionPda,
    positionMint,
    positionTokenAccount: ownerPositionAta,
  }));
  await sendTxWithRetry(connection, tx2, [owner]);
}

/**
 * Emergency: transfer NFT from vault back to owner.
 */
export async function emergencyReleaseNft(
  connection: Connection,
  vaultKeypair: Keypair,
  ownerPubkey: PublicKey,
  positionMint: PublicKey,
): Promise<string> {
  const vaultAta = getAssociatedTokenAddressSync(positionMint, vaultKeypair.publicKey, true);
  const ownerAta = getAssociatedTokenAddressSync(positionMint, ownerPubkey);
  const tx = new Transaction().add(
    createTransferInstruction(vaultAta, ownerAta, vaultKeypair.publicKey, 1)
  );
  const sig = await connection.sendTransaction(tx, [vaultKeypair]);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
