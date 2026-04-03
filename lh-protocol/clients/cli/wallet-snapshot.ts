/**
 * wallet-snapshot.ts — Wallet state capture for PnL tracking.
 *
 * Captures SOL balance, USDC balance, and total value at a point in time.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";

export interface WalletSnapshot {
  timestamp: number;
  wallet: string;
  solLamports: bigint;
  usdcMicro: bigint;
  solUsd: number;
  usdcUsd: number;
  totalValueUsd: number;
  price: number;
}

/**
 * Snapshot a wallet's SOL + USDC balances and compute total value.
 */
export async function snapshotWallet(
  connection: Connection,
  wallet: PublicKey,
  usdcMint: PublicKey,
  solPriceUsd: number
): Promise<WalletSnapshot> {
  // SOL balance
  const solLamports = BigInt(await connection.getBalance(wallet));

  // USDC balance
  let usdcMicro = BigInt(0);
  try {
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, wallet);
    const account = await getAccount(connection, usdcAta);
    usdcMicro = account.amount;
  } catch {
    // ATA doesn't exist — zero USDC balance
  }

  const solUsd = (Number(solLamports) / LAMPORTS_PER_SOL) * solPriceUsd;
  const usdcUsd = Number(usdcMicro) / 1e6;
  const totalValueUsd = solUsd + usdcUsd;

  return {
    timestamp: Math.floor(Date.now() / 1000),
    wallet: wallet.toBase58(),
    solLamports,
    usdcMicro,
    solUsd,
    usdcUsd,
    totalValueUsd,
    price: solPriceUsd,
  };
}

/**
 * Format a wallet snapshot for display.
 */
export function formatWalletSnapshot(
  snap: WalletSnapshot,
  label: string = ""
): string {
  const solAmount = (Number(snap.solLamports) / LAMPORTS_PER_SOL).toFixed(6);
  const usdcAmount = (Number(snap.usdcMicro) / 1e6).toFixed(6);
  const lines = [
    label ? `── ${label} ──` : `── Wallet: ${snap.wallet.slice(0, 12)}... ──`,
    `  Time:       ${new Date(snap.timestamp * 1000).toISOString()}`,
    `  SOL:        ${solAmount} ($${snap.solUsd.toFixed(2)})`,
    `  USDC:       ${usdcAmount}`,
    `  Total:      $${snap.totalValueUsd.toFixed(2)}`,
    `  SOL Price:  $${snap.price.toFixed(2)}`,
  ];
  return lines.join("\n");
}

/**
 * Compare two wallet snapshots and report the difference.
 */
export function compareWalletSnapshots(
  before: WalletSnapshot,
  after: WalletSnapshot,
  label: string = "Wallet PnL"
): string {
  const solDiff = Number(after.solLamports - before.solLamports) / LAMPORTS_PER_SOL;
  const usdcDiff = Number(after.usdcMicro - before.usdcMicro) / 1e6;
  const valueDiff = after.totalValueUsd - before.totalValueUsd;
  const pctChange =
    before.totalValueUsd > 0
      ? ((valueDiff / before.totalValueUsd) * 100).toFixed(2)
      : "N/A";

  const lines = [
    `── ${label} ──`,
    `  SOL change:   ${solDiff >= 0 ? "+" : ""}${solDiff.toFixed(6)}`,
    `  USDC change:  ${usdcDiff >= 0 ? "+" : ""}${usdcDiff.toFixed(6)}`,
    `  Value before: $${before.totalValueUsd.toFixed(2)}`,
    `  Value after:  $${after.totalValueUsd.toFixed(2)}`,
    `  PnL:          ${valueDiff >= 0 ? "+" : ""}$${valueDiff.toFixed(2)} (${pctChange}%)`,
  ];
  return lines.join("\n");
}
