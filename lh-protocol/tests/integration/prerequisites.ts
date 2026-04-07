/**
 * Prerequisites checker — validates wallets, balances, RPC, Whirlpool, Pyth
 * before any SOL is spent. All checks are read-only.
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  WHIRLPOOL_ADDRESS,
  PYTH_SOL_USD_FEED,
  USDC_MINT,
  CLUSTER,
} from "../../clients/cli/config";
import {
  decodeWhirlpoolAccount,
  sqrtPriceX64ToPrice,
  WhirlpoolData,
} from "../../clients/cli/whirlpool-ix";
import { TestConfig } from "./types";

export interface PrerequisiteResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  lpWallet: Keypair;
  rtWallet: Keypair;
  vaultKeypair: Keypair;
  connection: Connection;
  whirlpoolData: WhirlpoolData;
  entryPrice: number;
  estimatedCostUsd: number;
}

function loadKeypair(envVar: string, fallback?: string): Keypair {
  const p = process.env[envVar] || fallback;
  if (!p) throw new Error(`${envVar} env var required`);
  const resolved = p.replace("~", process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function checkPrerequisites(
  config: TestConfig
): Promise<PrerequisiteResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Environment variables ──────────────────────────────────────
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
  if (!rpcUrl) errors.push("ANCHOR_PROVIDER_URL not set");
  if (!process.env.WALLET_LP && !process.env.ANCHOR_WALLET) {
    errors.push("WALLET_LP or ANCHOR_WALLET not set");
  }
  if (!process.env.WALLET_RT) errors.push("WALLET_RT not set");
  if (!process.env.VAULT_KEYPAIR_PATH) errors.push("VAULT_KEYPAIR_PATH not set");

  if (CLUSTER !== "mainnet-beta") {
    warnings.push(`SOLANA_CLUSTER=${CLUSTER} — Orca pool and Pyth may not work on non-mainnet`);
  }

  // ── Load wallets ───────────────────────────────────────────────
  let lpWallet: Keypair;
  let rtWallet: Keypair;
  let vaultKeypair: Keypair;
  try {
    lpWallet = loadKeypair("WALLET_LP", process.env.ANCHOR_WALLET || "~/.config/solana/id.json");
    rtWallet = loadKeypair("WALLET_RT");
    vaultKeypair = loadKeypair("VAULT_KEYPAIR_PATH");
  } catch (e: any) {
    errors.push(`Wallet loading failed: ${e.message}`);
    return { passed: false, errors, warnings } as any;
  }

  // Verify distinct wallets
  const keys = [lpWallet.publicKey, rtWallet.publicKey, vaultKeypair.publicKey];
  const unique = new Set(keys.map((k) => k.toBase58()));
  if (unique.size < 3) errors.push("LP, RT, and Vault must be different wallets");

  // ── RPC connectivity ───────────────────────────────────────────
  const connection = new Connection(rpcUrl || "https://api.devnet.solana.com", "confirmed");
  try {
    await connection.getLatestBlockhash({ commitment: "confirmed" });
  } catch (e: any) {
    errors.push(`RPC unreachable: ${e.message}`);
    return { passed: false, errors, warnings } as any;
  }

  // ── SOL balances ───────────────────────────────────────────────
  const [lpSol, rtSol, vaultSol] = await Promise.all([
    connection.getBalance(lpWallet.publicKey),
    connection.getBalance(rtWallet.publicKey),
    connection.getBalance(vaultKeypair.publicKey),
  ]);

  const lpSolF = lpSol / LAMPORTS_PER_SOL;
  const rtSolF = rtSol / LAMPORTS_PER_SOL;
  const vaultSolF = vaultSol / LAMPORTS_PER_SOL;

  if (lpSolF < 0.1) errors.push(`LP SOL too low: ${lpSolF.toFixed(4)} (need >= 0.1)`);
  if (rtSolF < 0.02) errors.push(`RT SOL too low: ${rtSolF.toFixed(4)} (need >= 0.02)`);
  if (vaultSolF < 0.05) errors.push(`Vault SOL too low: ${vaultSolF.toFixed(4)} (need >= 0.05)`);

  // ── USDC balances ──────────────────────────────────────────────
  async function getUsdcBalance(owner: PublicKey): Promise<number> {
    try {
      const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
      const acc = await getAccount(connection, ata);
      return Number(acc.amount);
    } catch {
      return 0;
    }
  }

  const [lpUsdc, rtUsdc] = await Promise.all([
    getUsdcBalance(lpWallet.publicKey),
    getUsdcBalance(rtWallet.publicKey),
  ]);

  const neededLpUsdc = config.lpUsdc * 1e6 + 5_000_000; // position USDC + buffer for premium
  if (lpUsdc < neededLpUsdc) {
    errors.push(`LP USDC too low: ${(lpUsdc / 1e6).toFixed(2)} (need >= ${(neededLpUsdc / 1e6).toFixed(2)})`);
  }
  if (rtUsdc < config.rtDepositUsdc) {
    errors.push(`RT USDC too low: ${(rtUsdc / 1e6).toFixed(2)} (need >= ${(config.rtDepositUsdc / 1e6).toFixed(2)})`);
  }

  // ── Whirlpool ──────────────────────────────────────────────────
  let whirlpoolData: WhirlpoolData;
  let entryPrice = 0;
  try {
    const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
    if (!wpInfo) {
      errors.push(`Whirlpool not found: ${WHIRLPOOL_ADDRESS.toBase58()}`);
      return { passed: false, errors, warnings } as any;
    }
    whirlpoolData = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));
    entryPrice = sqrtPriceX64ToPrice(whirlpoolData.sqrtPrice);

    const mainnetUsdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    if (!whirlpoolData.tokenMintB.equals(mainnetUsdc) && !whirlpoolData.tokenMintB.equals(USDC_MINT)) {
      errors.push(`Whirlpool tokenMintB is not USDC: ${whirlpoolData.tokenMintB.toBase58()}`);
    }
  } catch (e: any) {
    errors.push(`Whirlpool decode failed: ${e.message}`);
    return { passed: false, errors, warnings } as any;
  }

  // ── Pyth ───────────────────────────────────────────────────────
  try {
    const pythInfo = await connection.getAccountInfo(PYTH_SOL_USD_FEED);
    if (!pythInfo) {
      errors.push(`Pyth feed not found: ${PYTH_SOL_USD_FEED.toBase58()}`);
    }
  } catch (e: any) {
    errors.push(`Pyth check failed: ${e.message}`);
  }

  // ── Cost estimation ────────────────────────────────────────────
  const estimatedSol = 0.05; // rent + ATAs + tx fees
  const estimatedCostUsd = estimatedSol * entryPrice;
  if (estimatedCostUsd > 80) {
    errors.push(`Estimated cost $${estimatedCostUsd.toFixed(2)} exceeds $80 budget`);
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    lpWallet,
    rtWallet,
    vaultKeypair,
    connection,
    whirlpoolData: whirlpoolData!,
    entryPrice,
    estimatedCostUsd,
  };
}
