#!/usr/bin/env ts-node
/**
 * live-demo-offchain.ts — Full 20-minute live hedging demo using the OFF-CHAIN EMULATOR.
 *
 * This script uses the OffchainLhProtocol (via ILhProtocol interface) instead of
 * the deployed Solana smart contract. All Orca operations and USDC transfers are
 * REAL on-chain transactions; only the protocol state management runs off-chain.
 *
 * TO SWITCH TO ON-CHAIN CONTRACTS LATER:
 *   1. Deploy the lh_core program to Solana
 *   2. Use scripts/live-demo.ts (the on-chain version) instead
 *   OR set PROTOCOL_MODE=onchain (once OnchainLhProtocol is implemented)
 *
 * The on-chain version (live-demo.ts) is preserved unchanged in this directory.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://mainnet.helius-rpc.com/?api-key=... \
 *   WALLET_LP=~/.config/solana/id.json \
 *   WALLET_RT=./wallet-rt.json \
 *   VAULT_KEYPAIR_PATH=./vault-wallet.json \
 *   WHIRLPOOL_ADDRESS=Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
 *   npx ts-node scripts/live-demo-offchain.ts
 *
 * Prerequisites:
 *   - Three wallets: LP, RT, Vault (generate vault: solana-keygen new -o vault-wallet.json)
 *   - LP wallet: funded with SOL + USDC (for position + premium)
 *   - RT wallet: funded with SOL (tx fees) + USDC (pool deposit)
 *   - Vault wallet: funded with SOL (tx fees for payouts/releases)
 *   - Orca SOL/USDC Whirlpool exists with liquidity
 */

import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ─── Protocol interface (the swap point) ─────────────────────────────
import { ILhProtocol } from "../protocol/interface";
import { OffchainLhProtocol } from "../protocol/offchain-emulator/index";
import { CertStatus } from "../protocol/types";

// ─── Orca tools (completely independent of protocol implementation) ──
import {
  WHIRLPOOL_ADDRESS,
  PYTH_SOL_USD_FEED,
  SOL_MINT,
  USDC_MINT,
} from "../clients/cli/config";
import {
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  getTickArrayStartIndex,
  decodeWhirlpoolAccount,
  alignTick,
  tickToSqrtPriceX64,
  sqrtPriceX64ToPrice,
  estimateLiquidity,
  buildOpenPositionIx,
  buildIncreaseLiquidityIx,
  deriveAta,
} from "../clients/cli/whirlpool-ix";
import {
  getOrCreateAta,
  buildCreateAtaIx,
  buildWrapSolIxs,
  buildUnwrapSolIx,
  sendTxWithRetry,
  formatSol,
  formatUsdc,
} from "../clients/cli/utils";
import {
  snapshotPosition,
  formatPositionSnapshot,
} from "../clients/cli/position-value";
import {
  snapshotWallet,
  formatWalletSnapshot,
  compareWalletSnapshots,
} from "../clients/cli/wallet-snapshot";

// ─── Demo Config ─────────────────────────────────────────────────────

const TENOR_SECONDS = 1200; // 20 minutes
const RT_DEPOSIT_USDC = 20_000_000; // 20 USDC
const LP_SOL = 0.01;
const LP_USDC = 2.0;
const CAP_USDC = 5_000_000; // 5 USDC cap
const NOTIONAL_USDC = 10_000_000; // 10 USDC notional
const BARRIER_PCT = 0.95; // 5% below entry
const MONITOR_INTERVAL_S = 60;
const TICK_WIDTH = 200;
const DATA_DIR = path.resolve(__dirname, "../protocol/offchain-emulator/data");

// ─── Helpers ─────────────────────────────────────────────────────────

function loadKeypair(envVar: string, fallback?: string): Keypair {
  const p = process.env[envVar] || fallback;
  if (!p) throw new Error(`${envVar} env var required`);
  const resolved = p.replace("~", process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send USDC from a wallet to the vault. Returns the tx signature
 * (needed by the off-chain emulator to verify the transfer).
 */
async function sendUsdcToVault(
  connection: Connection,
  sender: Keypair,
  vaultPubkey: PublicKey,
  usdcMint: PublicKey,
  amount: number
): Promise<string> {
  const senderAta = getAssociatedTokenAddressSync(usdcMint, sender.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPubkey, true);
  const ix = createTransferInstruction(senderAta, vaultAta, sender.publicKey, amount);
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [sender]);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  // ── Setup wallets ──────────────────────────────────────────────

  const lpWallet = loadKeypair("WALLET_LP", "~/.config/solana/id.json");
  const rtWallet = loadKeypair("WALLET_RT");
  const vaultKeypair = loadKeypair("VAULT_KEYPAIR_PATH");

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  // ── Create protocol instance (THE SWAP POINT) ─────────────────
  // Change to OnchainLhProtocol when smart contracts are deployed.
  const protocol: ILhProtocol = new OffchainLhProtocol(
    connection,
    vaultKeypair,
    DATA_DIR
  );

  // Get current Whirlpool state
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found: " + WHIRLPOOL_ADDRESS.toBase58());
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));
  const entryPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);
  const usdcMint = USDC_MINT;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   LIQUIDITY HEDGE PROTOCOL — LIVE DEMO (off-chain mode) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Mode:        OFF-CHAIN EMULATOR`);
  console.log(`  LP Wallet:   ${lpWallet.publicKey.toBase58()}`);
  console.log(`  RT Wallet:   ${rtWallet.publicKey.toBase58()}`);
  console.log(`  Vault:       ${vaultKeypair.publicKey.toBase58()}`);
  console.log(`  SOL Price:   $${entryPrice.toFixed(2)}`);
  console.log(`  Tenor:       ${TENOR_SECONDS}s (${(TENOR_SECONDS / 60).toFixed(0)} minutes)`);
  console.log(`  Data dir:    ${DATA_DIR}`);
  console.log();

  // ── Step 1: Initialize protocol (idempotent) ───────────────────

  console.log("Step 1: INITIALIZE PROTOCOL");
  try {
    await protocol.initPool(lpWallet, usdcMint, 8000);
    console.log("  Pool initialized (U_max=80%)");
  } catch (e: any) {
    if (e.message.includes("already")) console.log("  Pool already initialized");
    else throw e;
  }

  try {
    await protocol.createTemplate(lpWallet, {
      templateId: 2,
      tenorSeconds: TENOR_SECONDS,
      widthBps: 1000,
      severityPpm: 500_000,
      premiumFloorUsdc: 1_000,
      premiumCeilingUsdc: 1_000_000_000,
    });
    console.log("  Template 2 created (20-min tenor)");
  } catch (e: any) {
    if (e.message.includes("already")) console.log("  Template 2 already exists");
    else throw e;
  }

  await protocol.updateRegimeSnapshot(lpWallet, {
    sigmaPpm: 200_000,
    sigmaMaPpm: 180_000,
    stressFlag: false,
    carryBpsPerDay: 10,
  });
  console.log("  Regime snapshot updated (sigma=20%)");
  console.log();

  // ── Step 2: Initial wallet snapshots ───────────────────────────

  console.log("Step 2: INITIAL SNAPSHOTS");
  const w0_lp = await snapshotWallet(connection, lpWallet.publicKey, usdcMint, entryPrice);
  const w0_rt = await snapshotWallet(connection, rtWallet.publicKey, usdcMint, entryPrice);
  console.log(formatWalletSnapshot(w0_lp, "LP Wallet (before)"));
  console.log(formatWalletSnapshot(w0_rt, "RT Wallet (before)"));
  console.log();

  // ── Step 3: RT deposits USDC ───────────────────────────────────

  console.log("Step 3: RT DEPOSITS USDC INTO POOL");

  // Ensure vault has a USDC ATA
  await getOrCreateAta(connection, vaultKeypair, usdcMint, vaultKeypair.publicKey);

  // RT sends USDC to vault (real on-chain transfer)
  const depositTxSig = await sendUsdcToVault(
    connection, rtWallet, vaultKeypair.publicKey, usdcMint, RT_DEPOSIT_USDC
  );
  console.log(`  RT sent ${formatUsdc(RT_DEPOSIT_USDC)} USDC to vault (tx: ${depositTxSig.slice(0, 20)}...)`);

  // Protocol records the deposit
  const { shares } = await (protocol as OffchainLhProtocol).depositUsdc(
    rtWallet, RT_DEPOSIT_USDC, depositTxSig
  );
  console.log(`  Pool recorded deposit: ${shares} shares minted`);
  console.log();

  // ── Step 4: LP opens Orca position ─────────────────────────────

  console.log("Step 4: LP OPENS ORCA POSITION");

  const lowerTick = alignTick(wp.tickCurrentIndex - TICK_WIDTH, wp.tickSpacing, "down");
  const upperTick = alignTick(wp.tickCurrentIndex + TICK_WIDTH, wp.tickSpacing, "up");

  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(lpWallet.publicKey, positionMint);

  const lowerStart = getTickArrayStartIndex(lowerTick, wp.tickSpacing);
  const upperStart = getTickArrayStartIndex(upperTick, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, lowerStart);
  const [tickArrayUpper] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, upperStart);

  const solLamports = BigInt(Math.floor(LP_SOL * 1e9));
  const usdcMicro = BigInt(Math.floor(LP_USDC * 1e6));
  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);
  const liquidity = estimateLiquidity(solLamports, usdcMicro, wp.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const tokenMaxA = (solLamports * BigInt(110)) / BigInt(100);
  const tokenMaxB = (usdcMicro * BigInt(110)) / BigInt(100);

  const wsolAta = await getOrCreateAta(connection, lpWallet, SOL_MINT, lpWallet.publicKey);
  const lpUsdcAta = await getOrCreateAta(connection, lpWallet, wp.tokenMintB, lpWallet.publicKey);

  // Tx1: Open Orca position + add liquidity (unchanged — uses Orca program directly)
  const tx1 = new Transaction();
  tx1.add(buildOpenPositionIx({
    funder: lpWallet.publicKey, owner: lpWallet.publicKey,
    positionPda: orcaPositionPda, positionBump, positionMint,
    positionTokenAccount: ownerPositionAta, whirlpool: WHIRLPOOL_ADDRESS,
    tickLowerIndex: lowerTick, tickUpperIndex: upperTick,
  }));
  tx1.add(...buildWrapSolIxs(lpWallet.publicKey, wsolAta, Number(tokenMaxA)));
  tx1.add(buildIncreaseLiquidityIx({
    whirlpool: WHIRLPOOL_ADDRESS, positionAuthority: lpWallet.publicKey,
    positionPda: orcaPositionPda, positionTokenAccount: ownerPositionAta,
    tokenOwnerAccountA: wsolAta, tokenOwnerAccountB: lpUsdcAta,
    tokenVaultA: wp.tokenVaultA, tokenVaultB: wp.tokenVaultB,
    tickArrayLower, tickArrayUpper,
    liquidityAmount: liquidity, tokenMaxA, tokenMaxB,
  }));
  tx1.add(buildUnwrapSolIx(wsolAta, lpWallet.publicKey));
  await sendTxWithRetry(connection, tx1, [lpWallet, positionMintKp]);
  console.log(`  Orca position opened: ${positionMint.toBase58()}`);

  // ── Step 5: Lock position in emulator vault ────────────────────

  console.log("\nStep 5: LOCK POSITION IN VAULT");

  // Transfer NFT to vault wallet (real on-chain transfer)
  const vaultNftAta = await getOrCreateAta(
    connection, lpWallet, positionMint, vaultKeypair.publicKey
  );
  const nftTx = new Transaction().add(
    createTransferInstruction(ownerPositionAta, vaultNftAta, lpWallet.publicKey, 1)
  );
  await sendTxWithRetry(connection, nftTx, [lpWallet]);
  console.log("  NFT transferred to vault");

  // Protocol registers the locked position (validates Orca + Pyth)
  const priceE6 = Math.floor(entryPrice * 1_000_000);
  await protocol.registerLockedPosition(lpWallet, {
    positionMint,
    whirlpool: WHIRLPOOL_ADDRESS,
    p0PriceE6: priceE6,
    depositedA: Number(solLamports),
    depositedB: Number(usdcMicro),
    lowerTick,
    upperTick,
    pythFeed: PYTH_SOL_USD_FEED,
  });
  console.log("  Position registered (Orca + Pyth validated)");

  // ── Step 6: Buy certificate ────────────────────────────────────

  console.log("\nStep 6: BUY HEDGE CERTIFICATE");

  const barrierE6 = Math.floor(entryPrice * BARRIER_PCT * 1_000_000);

  // First compute what premium will be (read-only)
  const pool = await protocol.getPoolState();
  const regime = await protocol.getRegimeSnapshot();
  const template = await protocol.getTemplate(2);

  // Import pricing to preview the premium
  const { computeQuote } = await import(
    "../protocol/offchain-emulator/operations/pricing"
  );
  const preview = computeQuote(CAP_USDC, template, pool, regime);
  console.log(`  Expected premium: ${formatUsdc(preview.premiumUsdc)} USDC`);

  // LP sends premium USDC to vault (real on-chain transfer)
  const premiumTxSig = await sendUsdcToVault(
    connection, lpWallet, vaultKeypair.publicKey, usdcMint, preview.premiumUsdc
  );
  console.log(`  Premium sent to vault (tx: ${premiumTxSig.slice(0, 20)}...)`);

  // Protocol activates certificate
  const certResult = await (protocol as OffchainLhProtocol).buyCertificate(
    lpWallet,
    {
      positionMint,
      templateId: 2,
      capUsdc: CAP_USDC,
      lowerBarrierE6: barrierE6,
      notionalUsdc: NOTIONAL_USDC,
    },
    premiumTxSig
  );

  console.log(`  Certificate activated!`);
  console.log(`    Premium:  ${formatUsdc(certResult.premiumUsdc)} USDC`);
  console.log(`    Cap:      ${formatUsdc(certResult.capUsdc)} USDC`);
  console.log(`    Barrier:  $${(barrierE6 / 1e6).toFixed(4)}`);
  console.log(`    Expiry:   ${new Date(certResult.expiryTs * 1000).toISOString()}`);

  const premiumPaid = certResult.premiumUsdc;
  const expiryTs = certResult.expiryTs;

  // Entry position snapshot
  const pv0 = await snapshotPosition(
    connection, positionMint, WHIRLPOOL_ADDRESS, solLamports, usdcMicro
  );
  console.log();
  console.log(formatPositionSnapshot(pv0, "Position at Entry"));
  console.log();

  // ── Step 7: Monitor until expiry ───────────────────────────────

  console.log("MONITORING (every 60s until expiry)...");
  const startNow = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, expiryTs - startNow);

  for (let elapsed = 0; elapsed < waitSeconds; elapsed += MONITOR_INTERVAL_S) {
    const remaining = waitSeconds - elapsed;
    if (remaining <= 0) break;
    const waitTime = Math.min(MONITOR_INTERVAL_S, remaining) * 1000;
    await sleep(waitTime);

    try {
      const snap = await snapshotPosition(
        connection, positionMint, WHIRLPOOL_ADDRESS, solLamports, usdcMicro
      );
      const minutesLeft = Math.max(0, (expiryTs - Math.floor(Date.now() / 1000)) / 60);
      console.log(
        `  [${new Date().toISOString()}] Price=$${snap.price.toFixed(2)} ` +
        `Value=$${snap.valueUsd.toFixed(4)} IL=${snap.ilPct.toFixed(2)}% ` +
        `InRange=${snap.isInRange} (${minutesLeft.toFixed(0)}min left)`
      );
    } catch (e: any) {
      console.log(`  [Monitor] Error: ${e.message}`);
    }
  }

  // ── Step 8: Settlement ─────────────────────────────────────────

  console.log();
  console.log("Step 8: SETTLEMENT");

  const timeToExpiry = expiryTs - Math.floor(Date.now() / 1000);
  if (timeToExpiry > 0) {
    console.log(`  Waiting ${timeToExpiry}s for expiry...`);
    await sleep((timeToExpiry + 5) * 1000);
  }

  // Position snapshot at settlement
  const pv1 = await snapshotPosition(
    connection, positionMint, WHIRLPOOL_ADDRESS, solLamports, usdcMicro
  );
  console.log(formatPositionSnapshot(pv1, "Position at Settlement"));

  // Settle via protocol (reads real Pyth, sends real USDC if due)
  const settleResult = await protocol.settleCertificate(lpWallet, positionMint);
  console.log(`  Settlement: state=${settleResult.state} (${settleResult.state === CertStatus.SETTLED ? "PAYOUT" : "EXPIRED"})`);
  console.log(`  Payout: ${formatUsdc(settleResult.payout)} USDC`);
  console.log(`  Settlement price: $${(settleResult.settlementPriceE6 / 1e6).toFixed(4)}`);

  // ── Step 9: Cleanup ────────────────────────────────────────────

  console.log();
  console.log("Step 9: CLEANUP");

  // Release position (vault sends NFT back to LP)
  await protocol.releasePosition(lpWallet, positionMint);
  console.log("  Position released to LP");

  // RT withdraws
  const poolAfter = await protocol.getPoolState();
  const rtShareBalance = (protocol as OffchainLhProtocol)["store"]
    ? 0 // access share ledger via getPoolState
    : 0;
  // Use the shares we got at deposit
  try {
    const { usdcReturned } = await protocol.withdrawUsdc(rtWallet, shares);
    console.log(`  RT withdrew ${formatUsdc(usdcReturned)} USDC`);
  } catch (e: any) {
    console.log(`  RT withdrawal: ${e.message}`);
  }

  // ── Step 10: PnL Report ────────────────────────────────────────

  const settlementPrice = pv1.price;
  const w2_lp = await snapshotWallet(connection, lpWallet.publicKey, usdcMint, settlementPrice);
  const w2_rt = await snapshotWallet(connection, rtWallet.publicKey, usdcMint, settlementPrice);

  const positionPnl = pv1.valueUsd - pv0.valueUsd;
  const payout = settleResult.payout / 1e6;
  const premiumCost = premiumPaid / 1e6;
  const hedgedNetPnl = positionPnl + payout - premiumCost;
  const unhedgedPnl = positionPnl;
  const hedgeBenefit = hedgedNetPnl - unhedgedPnl;

  console.log();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║           HEDGING EFFECTIVENESS REPORT                   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`SOL Price:  Entry=$${entryPrice.toFixed(2)}  Settlement=$${settlementPrice.toFixed(2)}  Change=${(((settlementPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%`);
  console.log();
  console.log(`── Orca Position ──`);
  console.log(`  Entry value:      $${pv0.valueUsd.toFixed(4)}`);
  console.log(`  Settlement value: $${pv1.valueUsd.toFixed(4)}`);
  console.log(`  Position PnL:     ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(4)} (${pv0.valueUsd > 0 ? ((positionPnl / pv0.valueUsd) * 100).toFixed(2) : "0"}%)`);
  console.log(`  Hold value:       $${pv1.holdValueUsd.toFixed(4)}`);
  console.log(`  IL:               $${pv1.ilUsd.toFixed(4)} (${pv1.ilPct.toFixed(2)}%)`);
  console.log();
  console.log(`── Hedge Certificate ──`);
  console.log(`  Premium paid:     $${premiumCost.toFixed(6)}`);
  console.log(`  Cap:              $${(CAP_USDC / 1e6).toFixed(2)}`);
  console.log(`  Barrier:          $${(barrierE6 / 1e6).toFixed(4)}`);
  console.log(`  Settlement price: $${(settleResult.settlementPriceE6 / 1e6).toFixed(4)} (conservative: $${(settleResult.conservativePriceE6 / 1e6).toFixed(4)})`);
  console.log(`  Outcome:          ${settleResult.state === CertStatus.SETTLED ? "PAYOUT TRIGGERED" : "EXPIRED (no payout)"}`);
  if (payout > 0) console.log(`  Payout:           $${payout.toFixed(6)}`);
  console.log();
  console.log(`── LP Net PnL (Hedged) ──`);
  console.log(`  Position PnL:     ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(4)}`);
  console.log(`  Hedge payout:     +$${payout.toFixed(6)}`);
  console.log(`  Premium cost:     -$${premiumCost.toFixed(6)}`);
  console.log(`  Net PnL:          ${hedgedNetPnl >= 0 ? "+" : ""}$${hedgedNetPnl.toFixed(4)}`);
  console.log();
  console.log(`── LP PnL (Unhedged, counterfactual) ──`);
  console.log(`  Position PnL:     ${unhedgedPnl >= 0 ? "+" : ""}$${unhedgedPnl.toFixed(4)}`);
  console.log();
  console.log(`── Hedging Benefit ──`);
  console.log(`  Difference:       ${hedgeBenefit >= 0 ? "+" : ""}$${hedgeBenefit.toFixed(4)}`);
  console.log();
  console.log(compareWalletSnapshots(w0_lp, w2_lp, "LP Wallet PnL"));
  console.log();
  console.log(compareWalletSnapshots(w0_rt, w2_rt, "RT Wallet PnL"));
  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Protocol mode: OFF-CHAIN EMULATOR");
  console.log("  To switch to on-chain: deploy program + use live-demo.ts");
  console.log("  Audit log: " + path.join(DATA_DIR, "audit.jsonl"));
  console.log("  State file: " + path.join(DATA_DIR, "protocol-state.json"));
  console.log();
  console.log("  Demo complete.");
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
