/**
 * Pool operations: init, deposit, withdraw.
 * NAV-based share pricing — exact port of pool/instructions.rs.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PoolState, PoolV2Config, BPS } from "../../types";
import { StateStore } from "../state/store";
import {
  ensureVaultAta,
  verifyIncomingTransfer,
  transferFromVault,
} from "../chain/token-ops";
import { AuditLogger } from "../audit/logger";

export async function initPool(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  admin: Keypair,
  usdcMint: PublicKey,
  uMaxBps: number,
  v2Config?: PoolV2Config
): Promise<void> {
  if (store.getPool()) throw new Error("Pool already initialized");

  // Create vault USDC ATA
  const vaultAta = await ensureVaultAta(connection, vaultKeypair, usdcMint);

  const pool: PoolState = {
    admin: admin.publicKey.toBase58(),
    usdcMint: usdcMint.toBase58(),
    usdcVault: vaultAta.toBase58(),
    reservesUsdc: 0,
    activeCapUsdc: 0,
    totalShares: 0,
    uMaxBps,
    // v2 config (defaults = v1 behavior)
    premiumUpfrontBps: v2Config?.premiumUpfrontBps ?? 10_000,
    feeShareMinBps: v2Config?.feeShareMinBps ?? 0,
    feeShareMaxBps: v2Config?.feeShareMaxBps ?? 0,
    earlyExitPenaltyBps: v2Config?.earlyExitPenaltyBps ?? 0,
    rtTickWidthMultiplier: v2Config?.rtTickWidthMultiplier ?? 2,
  };

  store.setPool(pool);
  logger.logOperation("initPool", { admin: pool.admin, uMaxBps, v2Config }, store.getVersion());
}

/**
 * Deposit USDC into pool. Caller must have already transferred USDC
 * to the vault ATA and provide the tx signature for verification.
 */
export async function depositUsdc(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  depositor: Keypair,
  amount: number,
  txSignature: string
): Promise<{ shares: number }> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");
  if (amount <= 0) throw new Error("Amount must be positive");

  // Anti-replay
  if (store.isTxProcessed(txSignature)) {
    throw new Error(`Transaction already processed: ${txSignature}`);
  }

  // Verify the transfer on-chain
  const verified = await verifyIncomingTransfer(
    connection,
    txSignature,
    depositor.publicKey,
    new PublicKey(pool.usdcVault),
    amount,
    new PublicKey(pool.usdcMint)
  );
  if (!verified) throw new Error("USDC transfer verification failed");

  // NAV-based share calculation (from pool/instructions.rs:128-136)
  let shares: number;
  if (pool.totalShares === 0 || pool.reservesUsdc === 0) {
    shares = amount; // 1:1 for first deposit
  } else {
    shares = Math.floor((amount * pool.totalShares) / pool.reservesUsdc);
  }
  if (shares <= 0) throw new Error("Shares must be positive");

  // Update state
  store.updatePool((p) => {
    p.reservesUsdc += amount;
    p.totalShares += shares;
  });
  store.addShares(depositor.publicKey.toBase58(), shares);
  store.markTxProcessed(txSignature);

  logger.logOperation(
    "depositUsdc",
    { depositor: depositor.publicKey.toBase58(), amount, shares },
    store.getVersion(),
    "success",
    txSignature
  );

  return { shares };
}

/**
 * Withdraw USDC by burning shares. Service transfers USDC from vault.
 */
export async function withdrawUsdc(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  withdrawer: Keypair,
  sharesToBurn: number
): Promise<{ usdcReturned: number }> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");
  if (sharesToBurn <= 0) throw new Error("Shares must be positive");

  const currentShares = store.getShares(withdrawer.publicKey.toBase58());
  if (currentShares < sharesToBurn) {
    throw new Error(
      `Insufficient shares: have ${currentShares}, want to burn ${sharesToBurn}`
    );
  }

  // NAV-based USDC return
  const usdcToReturn = Math.floor(
    (sharesToBurn * pool.reservesUsdc) / pool.totalShares
  );

  // Utilization guard (from pool/instructions.rs:249-263)
  if (pool.activeCapUsdc > 0) {
    const postReserves = pool.reservesUsdc - usdcToReturn;
    const minReserves = Math.ceil(
      (pool.activeCapUsdc * BPS) / pool.uMaxBps
    );
    if (postReserves < minReserves) {
      throw new Error(
        `WithdrawalWouldBreachUtilization: postReserves=${postReserves} < minReserves=${minReserves}`
      );
    }
  }

  // Execute on-chain transfer from vault
  const txSig = await transferFromVault(
    connection,
    vaultKeypair,
    new PublicKey(pool.usdcMint),
    withdrawer.publicKey,
    usdcToReturn
  );

  // Update state
  store.updatePool((p) => {
    p.reservesUsdc -= usdcToReturn;
    p.totalShares -= sharesToBurn;
  });
  store.removeShares(withdrawer.publicKey.toBase58(), sharesToBurn);

  logger.logOperation(
    "withdrawUsdc",
    { withdrawer: withdrawer.publicKey.toBase58(), sharesToBurn, usdcToReturn },
    store.getVersion(),
    "success",
    txSig
  );

  return { usdcReturned: usdcToReturn };
}
