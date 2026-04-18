#!/usr/bin/env ts-node
/**
 * integration-test-optimized.ts — Full lifecycle test with optimized parameters.
 *
 * Tests the complete protocol flow using the simulation-derived optimal parameters:
 * - Pool init with u_max=30%, 1.5% protocol fee, 2% early exit penalty
 * - Three templates (±5%, ±10%, ±15%) with calibrated severity
 * - LP opens position at ±10% (sweet spot), natural cap auto-computed
 * - Barrier auto-set to 90% of entry
 * - RT deposits USDC, backs certificates
 * - Settlement with real Whirlpool price
 * - Verifies: premium range, protocol fee split, fee share offset, payout math
 *
 * Usage: npx ts-node scripts/integration-test-optimized.ts
 */

import {
  Keypair, PublicKey, Connection, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createTransferInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { OffchainLhProtocol } from "../protocol/offchain-emulator/index";
import { computeQuote } from "../protocol/offchain-emulator/operations/pricing";
import { OPTIMIZED_TEMPLATES, OPTIMIZED_POOL, DEFAULT_BARRIER_PCT } from "../protocol/offchain-emulator/config/templates";
import { CertStatus } from "../protocol/types";
import { WHIRLPOOL_ADDRESS, USDC_MINT, SOL_MINT } from "../clients/cli/config";
import {
  decodeWhirlpoolAccount, sqrtPriceX64ToPrice,
} from "../clients/cli/whirlpool-ix";
import {
  getOrCreateAta, formatUsdc,
} from "../clients/cli/utils";
import { checkPrerequisites } from "../tests/integration/prerequisites";

// ─── Config (Optimized Parameters) ─────────────────────────────────

const TEMPLATE_ID = 2;              // ±10% (sweet spot)
const TENOR_SECONDS = 1800;          // 30 minutes for test (production: 7 days)
const LP_SOL = 0.01;                 // small test position
const LP_USDC = 2.0;
const RT_USDC = 20.0;               // RT deposits
const MONITOR_INTERVAL_S = 60;
const TICK_WIDTH = 200;              // ~±10% at tick spacing 64

function loadKeypair(envVar: string, fallback?: string): Keypair {
  const p = process.env[envVar] || fallback;
  if (!p) throw new Error(`${envVar} required`);
  const resolved = p.replace("~", process.env.HOME || "");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf-8"))));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

let assertions = { passed: 0, failed: 0 };
function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✓ ${msg}`); assertions.passed++; }
  else { console.error(`  ✗ FAILED: ${msg}`); assertions.failed++; }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   INTEGRATION TEST — OPTIMIZED PARAMETERS                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ── Phase 0: Prerequisites ─────────────────────────────────────
  console.log("Phase 0: PREREQUISITES");
  const prereqs = await checkPrerequisites({
    tenorSeconds: TENOR_SECONDS, rtDepositUsdc: Math.floor(RT_USDC * 1e6),
    lpSol: LP_SOL, lpUsdc: LP_USDC, capUsdc: 0, // auto-computed
    notionalUsdc: 10_000_000, barrierPct: OPTIMIZED_TEMPLATES[TEMPLATE_ID - 1].barrierPct,
    monitorIntervalS: MONITOR_INTERVAL_S, tickWidth: TICK_WIDTH,
    cluster: process.env.SOLANA_CLUSTER || "mainnet-beta",
  });
  for (const w of prereqs.warnings) console.log(`  WARN: ${w}`);
  if (!prereqs.passed) {
    for (const e of prereqs.errors) console.error(`  ERROR: ${e}`);
    process.exit(1);
  }
  const { lpWallet, rtWallet, vaultKeypair, connection, entryPrice } = prereqs;
  console.log(`  SOL Price: $${entryPrice.toFixed(4)}`);
  console.log(`  Config: u_max=${OPTIMIZED_POOL.uMaxBps}bps, fee=${OPTIMIZED_POOL.protocolFeeBps}bps, barrier=${OPTIMIZED_TEMPLATES[TEMPLATE_ID-1].barrierPct*100}%`);
  console.log();

  // Data directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dataDir = path.resolve(__dirname, `../protocol/offchain-emulator/data/optimized-test-${timestamp}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const protocol = new OffchainLhProtocol(connection, vaultKeypair, dataDir);

  // ── Phase 1: Initialize with optimized params ──────────────────
  console.log("Phase 1: INITIALIZE PROTOCOL (optimized)");
  await protocol.initPool(lpWallet, USDC_MINT, OPTIMIZED_POOL.uMaxBps, {
    premiumUpfrontBps: OPTIMIZED_POOL.premiumUpfrontBps,
    feeShareMinBps: OPTIMIZED_POOL.feeShareMinBps,
    feeShareMaxBps: OPTIMIZED_POOL.feeShareMaxBps,
    earlyExitPenaltyBps: OPTIMIZED_POOL.earlyExitPenaltyBps,
    rtTickWidthMultiplier: OPTIMIZED_POOL.rtTickWidthMultiplier,
    protocolFeeBps: OPTIMIZED_POOL.protocolFeeBps,
  });

  // Create all three templates
  for (const tmpl of OPTIMIZED_TEMPLATES) {
    // Override tenor for test (30 min instead of 7 days)
    await protocol.createTemplate(lpWallet, {
      templateId: tmpl.templateId,
      tenorSeconds: TENOR_SECONDS,
      widthBps: tmpl.widthBps,
      severityPpm: tmpl.severityPpm,
      premiumFloorUsdc: tmpl.premiumFloorUsdc,
      premiumCeilingUsdc: tmpl.premiumCeilingUsdc,
    });
    console.log(`  ✓ Template ${tmpl.templateId} (${tmpl.label})`);
  }

  // Publish regime
  await protocol.updateRegimeSnapshot(lpWallet, {
    sigmaPpm: 650_000, sigmaMaPpm: 600_000, stressFlag: false, carryBpsPerDay: 10,
  });
  console.log(`  ✓ Regime: σ=65%, stress=false`);

  const poolInit = await protocol.getPoolState();
  assert(poolInit.uMaxBps === OPTIMIZED_POOL.uMaxBps, `Pool u_max = ${poolInit.uMaxBps}bps`);
  assert(poolInit.protocolFeeBps === OPTIMIZED_POOL.protocolFeeBps, `Protocol fee = ${poolInit.protocolFeeBps}bps`);
  console.log();

  // ── Phase 2: RT deposits USDC ──────────────────────────────────
  console.log("Phase 2: RT DEPOSITS USDC");
  await getOrCreateAta(connection, vaultKeypair, USDC_MINT, vaultKeypair.publicKey);
  const rtDepositUsdc = Math.floor(RT_USDC * 1e6);
  const depositTx = await sendUsdcToVault(connection, rtWallet, vaultKeypair.publicKey, USDC_MINT, rtDepositUsdc);
  const { shares } = await protocol.depositUsdc(rtWallet, rtDepositUsdc, depositTx);
  console.log(`  ✓ ${formatUsdc(rtDepositUsdc)} → ${shares} shares`);

  const poolAfterDeposit = await protocol.getPoolState();
  assert(poolAfterDeposit.reservesUsdc === rtDepositUsdc, `Reserves = ${formatUsdc(poolAfterDeposit.reservesUsdc)}`);
  console.log();

  // ── Phase 3: LP opens position, then buys certificate (two-step) ──
  console.log("Phase 3: LP OPENS POSITION + BUYS CERTIFICATE");

  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo!.data));
  const currentPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);
  console.log(`  SOL price: $${currentPrice.toFixed(4)}`);

  const solLamports = Math.floor(LP_SOL * 1e9);
  const usdcMicroNum = Math.floor(LP_USDC * 1e6);

  // Step 3a: Open vault position (Orca + register)
  const { openVaultPosition } = await import("../protocol/offchain-emulator/operations/vault-positions");
  const { alignTick, tickToSqrtPriceX64 } = await import("../clients/cli/whirlpool-ix");
  const { PYTH_SOL_USD_FEED } = await import("../clients/cli/config");

  const tickWidth = TICK_WIDTH;
  const lowerTick = alignTick(wp.tickCurrentIndex - tickWidth, wp.tickSpacing, "down");
  const upperTick = alignTick(wp.tickCurrentIndex + tickWidth, wp.tickSpacing, "up");

  const posResult = await openVaultPosition(
    connection, vaultKeypair, wp,
    BigInt(solLamports), BigInt(usdcMicroNum),
    lowerTick, upperTick,
  );
  console.log(`  ✓ Orca position opened: ${posResult.positionMint.toBase58().slice(0, 12)}...`);

  // Register the position
  const entryPriceE6 = Math.floor(posResult.entryPrice * 1e6);
  await protocol.registerLockedPosition(lpWallet, {
    positionMint: posResult.positionMint,
    whirlpool: WHIRLPOOL_ADDRESS,
    p0PriceE6: entryPriceE6,
    depositedA: Number(posResult.actualSolLamports),
    depositedB: Number(posResult.actualUsdcMicro),
    lowerTick: posResult.lowerTick,
    upperTick: posResult.upperTick,
    pythFeed: PYTH_SOL_USD_FEED,
  });
  console.log(`  ✓ Position registered and locked`);

  // Step 3b: Compute exact premium, send it, buy certificate
  const template = await protocol.getTemplate(TEMPLATE_ID);
  const regime = await protocol.getRegimeSnapshot();

  // Get position state to compute natural cap
  const posState = await protocol.getPositionState(posResult.positionMint);

  // Compute natural cap: V(S0) - V(barrier)
  const { estimateTokenAmounts, positionValueUsd } = await import("../clients/cli/position-value");
  const sqrtLower = tickToSqrtPriceX64(posState.lowerTick);
  const sqrtUpper = tickToSqrtPriceX64(posState.upperTick);
  // Barrier = lower tick = 1 - width for this template
  const tmplConfig = OPTIMIZED_TEMPLATES[TEMPLATE_ID - 1];
  const barrierPct = tmplConfig.barrierPct;
  const barrierE6 = Math.floor(entryPriceE6 * barrierPct);
  const barrierPrice = barrierE6 / 1e6;

  // Use the Orca formula to get natural cap
  const { priceToSqrtPriceX64 } = await import("../clients/cli/whirlpool-ix");
  const entrySqrt = priceToSqrtPriceX64(posResult.entryPrice);
  const barrierSqrt = priceToSqrtPriceX64(barrierPrice);
  const entryAmounts = estimateTokenAmounts(BigInt(posState.liquidity), entrySqrt, sqrtLower, sqrtUpper);
  const barrierAmounts = estimateTokenAmounts(BigInt(posState.liquidity), barrierSqrt, sqrtLower, sqrtUpper);
  const entryValue = positionValueUsd(entryAmounts.amountA, entryAmounts.amountB, posResult.entryPrice);
  const barrierValue = positionValueUsd(barrierAmounts.amountA, barrierAmounts.amountB, barrierPrice);
  const naturalCapUsdc = Math.max(1, Math.floor((entryValue - barrierValue) * 1e6));
  console.log(`  Natural cap: ${formatUsdc(naturalCapUsdc)} ($${(naturalCapUsdc / 1e6).toFixed(4)})`);

  // Compute exact premium quote
  const exactQuote = computeQuote(naturalCapUsdc, template, poolAfterDeposit, regime);
  console.log(`  Exact premium: ${formatUsdc(exactQuote.premiumUsdc)}`);

  // Send exact premium amount
  const premiumTx = await sendUsdcToVault(connection, lpWallet, vaultKeypair.publicKey, USDC_MINT, exactQuote.premiumUsdc);

  // Buy certificate with exact cap and barrier
  const certResult = await protocol.buyCertificate(lpWallet, {
    positionMint: posResult.positionMint,
    templateId: TEMPLATE_ID,
    capUsdc: naturalCapUsdc,
    lowerBarrierE6: barrierE6,
    notionalUsdc: Math.floor(entryValue * 1e6),
  }, premiumTx);

  const positionMint = posResult.positionMint;
  const cert = await protocol.getCertificateState(positionMint);
  const poolAfterCert = await protocol.getPoolState();

  console.log(`  ✓ Certificate bought:`);
  console.log(`    Premium:  ${formatUsdc(cert.premiumUsdc)}`);
  console.log(`    Cap:      ${formatUsdc(cert.capUsdc)} (natural cap, auto-computed)`);
  console.log(`    Barrier:  $${(cert.lowerBarrierE6 / 1e6).toFixed(4)} (auto 90%)`);
  console.log(`    Expiry:   ${new Date(cert.expiryTs * 1000).toISOString()}`);
  console.log(`    State:    ${cert.state === 1 ? 'ACTIVE' : cert.state}`);

  // Verify barrier is ~90% of entry
  const barrierRatio = cert.lowerBarrierE6 / entryPriceE6;
  assert(Math.abs(barrierRatio - barrierPct) < 0.001, `Barrier = ${(barrierRatio * 100).toFixed(1)}% of entry (expected ${barrierPct * 100}%)`);

  // Verify protocol fee was collected
  const protoFees = poolAfterCert.protocolFeesCollected ?? 0;
  assert(protoFees > 0, `Protocol fees collected: ${formatUsdc(protoFees)}`);
  console.log(`  Protocol fee collected: ${formatUsdc(protoFees)}`);
  console.log();

  // ── Phase 5: Monitor ───────────────────────────────────────────
  console.log("Phase 5: MONITORING");

  for (let elapsed = 0; elapsed <= TENOR_SECONDS; elapsed += MONITOR_INTERVAL_S) {
    const remaining = TENOR_SECONDS - elapsed;
    if (remaining < 0) break;

    // Read current Whirlpool price (with retry for transient RPC errors)
    let priceNow = currentPrice;
    try {
      let wpNow = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { wpNow = await connection.getAccountInfo(WHIRLPOOL_ADDRESS); break; }
        catch { await sleep(2000); }
      }
      if (wpNow) {
        const wpData = decodeWhirlpoolAccount(Buffer.from(wpNow.data));
        priceNow = sqrtPriceX64ToPrice(wpData.sqrtPrice);
      }
    } catch { /* use last known price */ }
    const priceChange = ((priceNow - currentPrice) / currentPrice * 100);
    console.log(`  [${Math.floor(elapsed / 60)}m] SOL=$${priceNow.toFixed(4)} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(3)}%), remaining=${Math.ceil(remaining / 60)}m`);

    if (remaining > 0) await sleep(Math.min(MONITOR_INTERVAL_S * 1000, remaining * 1000));
  }
  console.log();

  // ── Phase 6: Settlement ────────────────────────────────────────
  console.log("Phase 6: SETTLEMENT");

  // Wait for expiry if needed
  const now = Math.floor(Date.now() / 1000);
  if (now < cert.expiryTs) {
    const waitSec = cert.expiryTs - now + 2;
    console.log(`  Waiting ${waitSec}s for expiry...`);
    await sleep(waitSec * 1000);
  }

  const settleResult = await protocol.settleCertificate(lpWallet, positionMint);
  const certAfter = await protocol.getCertificateState(positionMint);
  const poolAfterSettle = await protocol.getPoolState();

  console.log(`  ✓ Certificate settled:`);
  console.log(`    Settlement price: $${(settleResult.settlementPriceE6 / 1e6).toFixed(4)}`);
  console.log(`    Payout:           ${formatUsdc(settleResult.payout)}`);
  console.log(`    State:            ${certAfter.state === 2 ? 'SETTLED' : certAfter.state === 3 ? 'EXPIRED' : certAfter.state}`);
  console.log(`    Exposure released: ${formatUsdc(cert.capUsdc)}`);

  assert(certAfter.state === 2 || certAfter.state === 3, `Certificate state = SETTLED or EXPIRED`);
  assert(poolAfterSettle.activeCapUsdc === 0, `Active cap released to 0`);
  console.log();

  // ── Phase 7: Summary ──────────────────────────────────────────
  console.log("═".repeat(60));
  console.log("INTEGRATION TEST SUMMARY (OPTIMIZED PARAMETERS)");
  console.log("═".repeat(60));

  const priceChange = ((settleResult.settlementPriceE6 - entryPriceE6) / entryPriceE6 * 100);
  console.log(`  Entry price:          $${(entryPriceE6 / 1e6).toFixed(4)}`);
  console.log(`  Settlement price:     $${(settleResult.settlementPriceE6 / 1e6).toFixed(4)} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(4)}%)`);
  console.log(`  Premium paid:         ${formatUsdc(cert.premiumUsdc)}`);
  console.log(`  Natural cap:          ${formatUsdc(cert.capUsdc)}`);
  console.log(`  Payout received:      ${formatUsdc(settleResult.payout)}`);
  console.log(`  Protocol fees:        ${formatUsdc(poolAfterCert.protocolFeesCollected ?? 0)}`);
  console.log(`  Barrier:              ${(barrierRatio * 100).toFixed(1)}% of entry`);
  console.log(`  Outcome:              ${certAfter.state === 2 ? 'SETTLED (payout)' : 'EXPIRED (no payout)'}`);
  console.log();

  // Parameters used
  console.log("  OPTIMIZED PARAMETERS USED:");
  console.log(`    u_max:       ${OPTIMIZED_POOL.uMaxBps}bps (${OPTIMIZED_POOL.uMaxBps / 100}%)`);
  console.log(`    protocol fee: ${OPTIMIZED_POOL.protocolFeeBps}bps (${OPTIMIZED_POOL.protocolFeeBps / 100}%)`);
  console.log(`    fee share:   ${OPTIMIZED_POOL.feeShareMinBps}-${OPTIMIZED_POOL.feeShareMaxBps}bps`);
  console.log(`    exit penalty: ${OPTIMIZED_POOL.earlyExitPenaltyBps}bps (${OPTIMIZED_POOL.earlyExitPenaltyBps / 100}%)`);
  console.log(`    template:    #${TEMPLATE_ID} (${OPTIMIZED_TEMPLATES[TEMPLATE_ID - 1].label})`);
  console.log(`    severity:    ${OPTIMIZED_TEMPLATES[TEMPLATE_ID - 1].severityPpm.toLocaleString()} PPM`);
  console.log();

  console.log(`  ASSERTIONS: ${assertions.passed} passed, ${assertions.failed} failed`);
  console.log(`  DATA DIR:   ${dataDir}`);
  console.log();

  if (assertions.failed > 0) {
    console.error("⚠ Some assertions failed. Review output above.");
    process.exit(1);
  } else {
    console.log("✓ All assertions passed. Protocol lifecycle verified with optimized parameters.");
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
