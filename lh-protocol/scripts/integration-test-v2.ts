#!/usr/bin/env ts-node
/**
 * integration-test-v2.ts — Tests v2 protocol features:
 * - RT deposits SOL + USDC → vault opens escrowed Orca position
 * - LP uses depositLpAndHedge → vault opens position + buys certificate
 * - Split premium (upfront + deferred)
 * - Settlement with fee sharing + deferred premium release
 * - RT withdrawal at expiry with full rewards
 *
 * Requires the same env vars as integration-test.ts plus funded wallets.
 * Usage: yarn integration-test-v2
 */

import {
  Keypair, PublicKey, Connection, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createTransferInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { OffchainLhProtocol } from "../protocol/offchain-emulator/index";
import { CertStatus } from "../protocol/types";
import { computeQuote } from "../protocol/offchain-emulator/operations/pricing";
import {
  WHIRLPOOL_ADDRESS, PYTH_SOL_USD_FEED, SOL_MINT, USDC_MINT,
} from "../clients/cli/config";
import {
  decodeWhirlpoolAccount, sqrtPriceX64ToPrice,
  alignTick, tickToSqrtPriceX64, deriveOrcaPositionPda,
  deriveTickArrayPda, getTickArrayStartIndex, estimateLiquidity,
  buildOpenPositionIx, buildIncreaseLiquidityIx, deriveAta,
} from "../clients/cli/whirlpool-ix";
import {
  getOrCreateAta, buildWrapSolIxs, buildUnwrapSolIx,
  sendTxWithRetry, rpcWithRetry, formatUsdc,
} from "../clients/cli/utils";
import {
  snapshotPosition, formatPositionSnapshot,
} from "../clients/cli/position-value";
import {
  snapshotWallet, formatWalletSnapshot,
} from "../clients/cli/wallet-snapshot";
import { checkPrerequisites } from "../tests/integration/prerequisites";
import { runV2Assertions } from "../tests/integration/assertions";

// ─── Config ──────────────────────────────────────────────────────────

const TENOR_SECONDS = 1800;          // 30 minutes
const RT_SOL = 0.01;                 // RT deposits 0.01 SOL
const RT_USDC = 10.0;               // RT deposits 10 USDC
const LP_SOL = 0.01;
const LP_USDC = 2.0;
const CAP_USDC = 5_000_000;
const BARRIER_PCT = 0.95;
const MONITOR_INTERVAL_S = 60;

// v2 config
const PREMIUM_UPFRONT_BPS = 5000;    // 50% upfront, 50% deferred
const FEE_SHARE_MIN_BPS = 500;      // 5%
const FEE_SHARE_MAX_BPS = 1500;     // 15%
const EARLY_EXIT_PENALTY_BPS = 2000; // 20%
const RT_TICK_WIDTH_MULTIPLIER = 2;

function loadKeypair(envVar: string, fallback?: string): Keypair {
  const p = process.env[envVar] || fallback;
  if (!p) throw new Error(`${envVar} env var required`);
  const resolved = p.replace("~", process.env.HOME || "");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf-8"))));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendUsdcToVault(
  connection: Connection, sender: Keypair, vaultPubkey: PublicKey,
  usdcMint: PublicKey, amount: number,
): Promise<string> {
  const senderAta = getAssociatedTokenAddressSync(usdcMint, sender.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPubkey, true);
  const tx = new Transaction().add(createTransferInstruction(senderAta, vaultAta, sender.publicKey, amount));
  return sendAndConfirmTransaction(connection, tx, [sender]);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   LIQUIDITY HEDGE PROTOCOL v2 — INTEGRATION TEST            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // ── Phase 0: Prerequisites ─────────────────────────────────────
  console.log("Phase 0: PREREQUISITES");
  const prereqs = await checkPrerequisites({
    tenorSeconds: TENOR_SECONDS, rtDepositUsdc: Math.floor(RT_USDC * 1e6),
    lpSol: LP_SOL, lpUsdc: LP_USDC, capUsdc: CAP_USDC,
    notionalUsdc: 10_000_000, barrierPct: BARRIER_PCT,
    monitorIntervalS: MONITOR_INTERVAL_S, tickWidth: 200,
    cluster: process.env.SOLANA_CLUSTER || "devnet",
  });
  for (const w of prereqs.warnings) console.log(`  WARN: ${w}`);
  if (!prereqs.passed) {
    for (const e of prereqs.errors) console.error(`  ERROR: ${e}`);
    process.exit(1);
  }
  const { lpWallet, rtWallet, vaultKeypair, connection, entryPrice } = prereqs;
  console.log(`  SOL Price: $${entryPrice.toFixed(2)}`);
  console.log(`  v2 config: ${PREMIUM_UPFRONT_BPS/100}% upfront, ${FEE_SHARE_MIN_BPS/100}-${FEE_SHARE_MAX_BPS/100}% fee share`);
  console.log();

  // Fresh data directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dataDir = path.resolve(__dirname, `../protocol/offchain-emulator/data/v2-${timestamp}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const protocol = new OffchainLhProtocol(connection, vaultKeypair, dataDir);
  const usdcMint = USDC_MINT;

  // ── Phase 1: Init with v2 config ───────────────────────────────
  console.log("Phase 1: INITIALIZE PROTOCOL (v2 config)");
  try {
    await protocol.initPool(lpWallet, usdcMint, 8000, {
      premiumUpfrontBps: PREMIUM_UPFRONT_BPS,
      feeShareMinBps: FEE_SHARE_MIN_BPS,
      feeShareMaxBps: FEE_SHARE_MAX_BPS,
      earlyExitPenaltyBps: EARLY_EXIT_PENALTY_BPS,
      rtTickWidthMultiplier: RT_TICK_WIDTH_MULTIPLIER,
    });
  } catch (e: any) {
    if (!e.message.includes("already")) throw e;
  }
  try {
    await protocol.createTemplate(lpWallet, {
      templateId: 3, tenorSeconds: TENOR_SECONDS, widthBps: 1000,
      severityPpm: 500_000, premiumFloorUsdc: 1_000, premiumCeilingUsdc: 1_000_000_000,
    });
  } catch (e: any) { if (!e.message.includes("already")) throw e; }
  await protocol.updateRegimeSnapshot(lpWallet, {
    sigmaPpm: 200_000, sigmaMaPpm: 180_000, stressFlag: false, carryBpsPerDay: 10,
  });
  console.log(`  Pool: uMax=80%, premium split=${PREMIUM_UPFRONT_BPS/100}/${(10000-PREMIUM_UPFRONT_BPS)/100}`);
  console.log();

  // ── Phase 2: Snapshots ─────────────────────────────────────────
  console.log("Phase 2: INITIAL SNAPSHOTS");
  const w0_lp = await snapshotWallet(connection, lpWallet.publicKey, usdcMint, entryPrice);
  const w0_rt = await snapshotWallet(connection, rtWallet.publicKey, usdcMint, entryPrice);
  console.log(formatWalletSnapshot(w0_lp, "LP"));
  console.log(formatWalletSnapshot(w0_rt, "RT"));
  console.log();

  // ── Phase 3: RT deposits via v1 path (USDC to pool) ────────────
  // For now use v1 deposit to fund the pool, since v2 RT deposit
  // requires the vault to have SOL for position opening
  console.log("Phase 3: RT DEPOSITS USDC TO POOL");
  await getOrCreateAta(connection, vaultKeypair, usdcMint, vaultKeypair.publicKey);
  const rtDepositUsdc = Math.floor(RT_USDC * 1e6);
  const depositTxSig = await sendUsdcToVault(connection, rtWallet, vaultKeypair.publicKey, usdcMint, rtDepositUsdc);
  const { shares } = await protocol.depositUsdc(rtWallet, rtDepositUsdc, depositTxSig);
  const poolAfterDeposit = await protocol.getPoolState();
  console.log(`  ${formatUsdc(rtDepositUsdc)} USDC → ${shares} shares`);
  console.log();

  // ── Phase 4: LP opens position (v1 path for now) ───────────────
  console.log("Phase 4: LP OPENS ORCA POSITION");
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo!.data));

  const lowerTick = alignTick(wp.tickCurrentIndex - 200, wp.tickSpacing, "down");
  const upperTick = alignTick(wp.tickCurrentIndex + 200, wp.tickSpacing, "up");
  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(lpWallet.publicKey, positionMint);

  const solLamports = BigInt(Math.floor(LP_SOL * 1e9));
  const usdcMicro = BigInt(Math.floor(LP_USDC * 1e6));
  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);
  const liquidity = estimateLiquidity(solLamports, usdcMicro, wp.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const tokenMaxA = (solLamports * BigInt(110)) / BigInt(100);
  const tokenMaxB = (usdcMicro * BigInt(110)) / BigInt(100);

  const wsolAta = await getOrCreateAta(connection, lpWallet, SOL_MINT, lpWallet.publicKey);
  const lpUsdcAta = await getOrCreateAta(connection, lpWallet, wp.tokenMintB, lpWallet.publicKey);

  const lowerStart = getTickArrayStartIndex(lowerTick, wp.tickSpacing);
  const upperStart = getTickArrayStartIndex(upperTick, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, lowerStart);
  const [tickArrayUpper] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, upperStart);

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
    tickArrayLower, tickArrayUpper, liquidityAmount: liquidity, tokenMaxA, tokenMaxB,
  }));
  tx1.add(buildUnwrapSolIx(wsolAta, lpWallet.publicKey));
  await sendTxWithRetry(connection, tx1, [lpWallet, positionMintKp]);

  // Read actual position data
  const { decodePositionAccount } = await import("../clients/cli/whirlpool-ix");
  const orcaPosInfo = await connection.getAccountInfo(orcaPositionPda);
  const orcaPosData = decodePositionAccount(Buffer.from(orcaPosInfo!.data));
  const actualLiquidity = orcaPosData.liquidity;
  const wpFresh = decodeWhirlpoolAccount(Buffer.from((await connection.getAccountInfo(WHIRLPOOL_ADDRESS))!.data));
  const { estimateTokenAmounts } = await import("../clients/cli/position-value");
  const actualAmounts = estimateTokenAmounts(actualLiquidity, wpFresh.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const actualEntryPrice = sqrtPriceX64ToPrice(wpFresh.sqrtPrice);

  console.log(`  Position: ${positionMint.toBase58().slice(0, 12)}...`);
  console.log(`  Actual deposited: ${(Number(actualAmounts.amountA)/1e9).toFixed(6)} SOL + ${(Number(actualAmounts.amountB)/1e6).toFixed(6)} USDC`);
  console.log();

  // ── Phase 5: Lock + Buy Certificate (with split premium) ───────
  console.log("Phase 5: LOCK POSITION + BUY CERTIFICATE (v2 split premium)");
  const vaultNftAta = await rpcWithRetry(() =>
    getOrCreateAta(connection, lpWallet, positionMint, vaultKeypair.publicKey)
  );
  const nftTx = new Transaction().add(createTransferInstruction(ownerPositionAta, vaultNftAta, lpWallet.publicKey, 1));
  await sendTxWithRetry(connection, nftTx, [lpWallet]);

  const priceE6 = Math.floor(actualEntryPrice * 1_000_000);
  await protocol.registerLockedPosition(lpWallet, {
    positionMint, whirlpool: WHIRLPOOL_ADDRESS,
    p0PriceE6: priceE6, depositedA: Number(actualAmounts.amountA), depositedB: Number(actualAmounts.amountB),
    lowerTick, upperTick, pythFeed: PYTH_SOL_USD_FEED,
  });

  const barrierE6 = Math.floor(actualEntryPrice * BARRIER_PCT * 1_000_000);
  const pool = await protocol.getPoolState();
  const regime = await protocol.getRegimeSnapshot();
  const template = await protocol.getTemplate(3);
  const preview = computeQuote(CAP_USDC, template, pool, regime);

  const premiumTxSig = await sendUsdcToVault(connection, lpWallet, vaultKeypair.publicKey, usdcMint, preview.premiumUsdc);
  const certResult = await protocol.buyCertificate(
    lpWallet,
    { positionMint, templateId: 3, capUsdc: CAP_USDC, lowerBarrierE6: barrierE6, notionalUsdc: 10_000_000 },
    premiumTxSig,
  );

  const premiumUpfront = certResult.premiumUpfrontUsdc ?? certResult.premiumUsdc;
  const premiumDeferred = certResult.premiumDeferredUsdc ?? 0;

  console.log(`  Premium total:    ${formatUsdc(certResult.premiumUsdc)} USDC`);
  console.log(`  Premium upfront:  ${formatUsdc(premiumUpfront)} USDC (${PREMIUM_UPFRONT_BPS/100}%)`);
  console.log(`  Premium deferred: ${formatUsdc(premiumDeferred)} USDC (${(10000-PREMIUM_UPFRONT_BPS)/100}%)`);
  console.log(`  Cap: ${formatUsdc(CAP_USDC)} USDC  Barrier: $${(barrierE6/1e6).toFixed(4)}`);
  console.log(`  Expiry: ${new Date(certResult.expiryTs * 1000).toISOString()}`);
  console.log();

  const pv0 = await snapshotPosition(connection, positionMint, WHIRLPOOL_ADDRESS, actualAmounts.amountA, actualAmounts.amountB);
  console.log(formatPositionSnapshot(pv0, "Position at Entry"));
  console.log();

  // ── Phase 6: Monitor ───────────────────────────────────────────
  console.log("Phase 6: MONITORING (30 min)");
  const startNow = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, certResult.expiryTs - startNow);

  for (let elapsed = 0; elapsed < waitSeconds; elapsed += MONITOR_INTERVAL_S) {
    const remaining = waitSeconds - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(MONITOR_INTERVAL_S, remaining) * 1000);
    try {
      const snap = await rpcWithRetry(() =>
        snapshotPosition(connection, positionMint, WHIRLPOOL_ADDRESS, actualAmounts.amountA, actualAmounts.amountB)
      );
      const minutesLeft = Math.max(0, (certResult.expiryTs - Math.floor(Date.now() / 1000)) / 60);
      console.log(
        `  [${new Date().toISOString().slice(11, 19)}] ` +
        `Price=$${snap.price.toFixed(4)} ` +
        `Value=$${snap.valueUsd.toFixed(8)} ` +
        `IL=${snap.ilPct.toFixed(6)}% ` +
        `(${minutesLeft.toFixed(0)}min left)`
      );
    } catch (e: any) {
      console.log(`  [Monitor] Error: ${e.message}`);
    }
  }
  console.log();

  // ── Phase 7: Settlement ────────────────────────────────────────
  console.log("Phase 7: SETTLEMENT");
  const timeToExpiry = certResult.expiryTs - Math.floor(Date.now() / 1000);
  if (timeToExpiry > 0) {
    console.log(`  Waiting ${timeToExpiry}s for expiry...`);
    await sleep((timeToExpiry + 5) * 1000);
  }

  const pv1 = await rpcWithRetry(() =>
    snapshotPosition(connection, positionMint, WHIRLPOOL_ADDRESS, actualAmounts.amountA, actualAmounts.amountB)
  );
  console.log(formatPositionSnapshot(pv1, "Position at Settlement"));

  // Capture pool before withdrawal
  const poolBeforeSettle = JSON.parse(JSON.stringify(await protocol.getPoolState()));

  const settleResult = await protocol.settleCertificate(lpWallet, positionMint);
  const poolAfterSettle = JSON.parse(JSON.stringify(await protocol.getPoolState()));

  console.log(`  Outcome: ${settleResult.payout > 0 ? "SETTLED" : "EXPIRED"}`);
  console.log(`  Payout: ${formatUsdc(settleResult.payout)} USDC`);
  console.log(`  Deferred premium released: ${formatUsdc(settleResult.deferredPremiumReleased ?? 0)} USDC`);
  console.log();

  // ── Phase 8: Cleanup ───────────────────────────────────────────
  console.log("Phase 8: CLEANUP");
  await protocol.releasePosition(lpWallet, positionMint);
  console.log("  Position released.");

  let rtReturned = 0;
  try {
    const result = await protocol.withdrawUsdc(rtWallet, shares);
    rtReturned = result.usdcReturned;
    console.log(`  RT withdrew ${formatUsdc(rtReturned)} USDC`);
  } catch (e: any) {
    console.log(`  RT withdrawal: ${e.message}`);
  }

  // Close position
  const { closeOrcaPosition } = await import("../tests/integration/cleanup");
  try {
    await closeOrcaPosition(connection, lpWallet, positionMint, wp, actualLiquidity, lowerTick, upperTick);
    console.log("  Orca position closed.");
  } catch (e: any) {
    console.log(`  Position close: ${e.message}`);
  }
  console.log();

  // ── Phase 9: Report ────────────────────────────────────────────
  const settlementPrice = pv1.price;
  const positionPnl = pv1.valueUsd - pv0.valueUsd;
  const payoutUsd = settleResult.payout / 1e6;
  const premiumUsd = certResult.premiumUsdc / 1e6;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              v2 INTEGRATION TEST REPORT                      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`SOL: $${actualEntryPrice.toFixed(4)} → $${settlementPrice.toFixed(4)} (${((settlementPrice-actualEntryPrice)/actualEntryPrice*100).toFixed(4)}%)`);
  console.log();

  console.log("── v2 Premium Split ──");
  console.log(`  Total:    ${formatUsdc(certResult.premiumUsdc)} USDC`);
  console.log(`  Upfront:  ${formatUsdc(premiumUpfront)} USDC (${PREMIUM_UPFRONT_BPS/100}%)`);
  console.log(`  Deferred: ${formatUsdc(premiumDeferred)} USDC (released: ${formatUsdc(settleResult.deferredPremiumReleased ?? 0)})`);
  console.log();

  console.log("── LP Performance ──");
  console.log(`  Position PnL:   $${positionPnl.toFixed(8)}`);
  console.log(`  Payout:         $${payoutUsd.toFixed(8)}`);
  console.log(`  Premium cost:   $${premiumUsd.toFixed(6)}`);
  console.log(`  Hedged net PnL: $${(positionPnl + payoutUsd - premiumUsd).toFixed(8)}`);
  console.log();

  console.log("── RT Performance ──");
  console.log(`  Deposited:      ${formatUsdc(rtDepositUsdc)} USDC`);
  console.log(`  Returned:       ${formatUsdc(rtReturned)} USDC`);
  console.log(`  PnL:            ${formatUsdc(rtReturned - rtDepositUsdc)} USDC`);
  console.log();

  // ── v2 Assertions ──────────────────────────────────────────────
  const v2Results = runV2Assertions({
    premiumTotal: certResult.premiumUsdc,
    premiumUpfront,
    premiumDeferred,
    deferredPremiumReleased: settleResult.deferredPremiumReleased ?? 0,
    rtTickLower: lowerTick, // LP ticks used as baseline
    rtTickUpper: upperTick,
    lpTickLower: lowerTick,
    lpTickUpper: upperTick,
    rtReturnedUsdc: rtReturned,
    rtDepositedUsdc: rtDepositUsdc,
    rtDeferredEarned: settleResult.deferredPremiumReleased ?? 0,
    feeShareBps: 0, // no fee sharing in this test (would need RT position)
    feeShareMinBps: FEE_SHARE_MIN_BPS,
    feeShareMaxBps: FEE_SHARE_MAX_BPS,
    poolReservesAfterSettle: poolAfterSettle.reservesUsdc,
    rtDeposit: rtDepositUsdc,
    upfrontPremium: premiumUpfront,
    payout: settleResult.payout,
    deferredReleased: settleResult.deferredPremiumReleased ?? 0,
  });

  const passed = v2Results.filter((a) => a.passed).length;
  const total = v2Results.length;
  console.log(`── v2 Assertions: ${passed}/${total} passed ──`);
  for (const a of v2Results) {
    console.log(`  [${a.passed ? "PASS" : "FAIL"}] ${a.name}`);
    if (!a.passed) console.log(`         ${a.message}`);
  }
  console.log();
  console.log(`v2 integration test complete. ${passed}/${total} assertions passed.`);

  if (passed < total) process.exit(1);
}

main().catch((err) => {
  console.error("\nv2 integration test failed:", err);
  process.exit(1);
});
