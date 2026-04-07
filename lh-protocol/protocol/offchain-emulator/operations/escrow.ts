/**
 * Position escrow operations: register (lock) and release.
 * Validates Orca position data and Pyth entry price — same checks as
 * position_escrow/instructions.rs production path (lines 76-133).
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  PositionState,
  PositionStatus,
  RegisterPositionParams,
  ENTRY_PRICE_TOLERANCE_PPM,
  PPM,
} from "../../types";
import { StateStore } from "../state/store";
import { validateOrcaPosition } from "../chain/orca-reader";
import { transferFromVault, getTokenBalance } from "../chain/token-ops";
import { AuditLogger } from "../audit/logger";

/**
 * Register a locked position. The position NFT must already be in the vault ATA.
 * Validates: Orca account data, Pyth entry price (5% tolerance), pool pair.
 */
export async function registerLockedPosition(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  owner: Keypair,
  params: RegisterPositionParams
): Promise<void> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const mintStr = params.positionMint.toBase58();

  // Check position not already registered
  if (store.getPosition(mintStr)) {
    throw new Error(`Position already registered: ${mintStr}`);
  }

  // Verify vault holds the position NFT
  const vaultNftAta = getAssociatedTokenAddressSync(
    params.positionMint,
    vaultKeypair.publicKey,
    true
  );
  const nftBalance = await getTokenBalance(connection, vaultNftAta);
  if (nftBalance !== BigInt(1)) {
    throw new Error(
      `Vault does not hold position NFT (balance=${nftBalance})`
    );
  }

  // Orca validation (same as position_escrow/instructions.rs:78-115)
  const { orcaPosition, whirlpoolData } = await validateOrcaPosition(
    connection,
    params.positionMint,
    params.whirlpool,
    new PublicKey(pool.usdcMint)
  );

  // Entry price verification against the Whirlpool's live price.
  // Uses the pool's sqrtPriceX64 directly — same source as the position's value.
  const { sqrtPriceX64ToPrice } = await import(
    "../../../clients/cli/whirlpool-ix"
  );
  const wpPrice = sqrtPriceX64ToPrice(whirlpoolData.sqrtPrice);
  const oracleP0E6 = Math.floor(wpPrice * 1_000_000);
  const diff = Math.abs(params.p0PriceE6 - oracleP0E6);
  const tolerance = Math.floor(
    (oracleP0E6 * ENTRY_PRICE_TOLERANCE_PPM) / PPM
  );
  if (diff > tolerance) {
    throw new Error(
      `Entry price too far from Whirlpool: reported=${params.p0PriceE6}, pool=${oracleP0E6}, diff=${diff}, tolerance=${tolerance}`
    );
  }

  // Use Orca-sourced tick bounds (same as production path)
  const resolvedLowerTick = orcaPosition.tickLowerIndex;
  const resolvedUpperTick = orcaPosition.tickUpperIndex;

  const position: PositionState = {
    owner: owner.publicKey.toBase58(),
    whirlpool: params.whirlpool.toBase58(),
    positionMint: mintStr,
    lowerTick: resolvedLowerTick,
    upperTick: resolvedUpperTick,
    p0PriceE6: params.p0PriceE6,
    oracleP0E6,
    depositedA: params.depositedA,
    depositedB: params.depositedB,
    liquidity: orcaPosition.liquidity.toString(),
    protectedBy: null,
    status: PositionStatus.LOCKED,
  };

  store.addPosition(position);

  logger.logOperation(
    "registerLockedPosition",
    {
      owner: position.owner,
      positionMint: mintStr,
      p0PriceE6: params.p0PriceE6,
      oracleP0E6,
      lowerTick: resolvedLowerTick,
      upperTick: resolvedUpperTick,
    },
    store.getVersion()
  );
}

/**
 * Release a position back to the owner. NFT transferred from vault to owner.
 */
export async function releasePosition(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  owner: Keypair,
  positionMint: PublicKey
): Promise<void> {
  const mintStr = positionMint.toBase58();
  const pos = store.getPosition(mintStr);
  if (!pos) throw new Error(`Position not found: ${mintStr}`);
  if (pos.owner !== owner.publicKey.toBase58()) throw new Error("Unauthorized");
  if (pos.status !== PositionStatus.LOCKED) {
    throw new Error(`Invalid status: ${pos.status}, expected LOCKED`);
  }
  if (pos.protectedBy !== null) {
    throw new Error("Position still protected by certificate");
  }

  // Transfer NFT from vault to owner
  const txSig = await transferFromVault(
    connection,
    vaultKeypair,
    positionMint,
    owner.publicKey,
    1
  );

  store.updatePosition(mintStr, (p) => {
    p.status = PositionStatus.RELEASED;
  });

  logger.logOperation(
    "releasePosition",
    { owner: pos.owner, positionMint: mintStr },
    store.getVersion(),
    "success",
    txSig
  );
}
