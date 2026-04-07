#!/usr/bin/env ts-node
/**
 * integration-test.ts — Full integration test using real mainnet Orca positions,
 * real Pyth oracle, and the off-chain protocol emulator.
 *
 * Usage:
 *   SOLANA_CLUSTER=mainnet-beta \
 *   ANCHOR_PROVIDER_URL=https://mainnet.helius-rpc.com/?api-key=... \
 *   WALLET_LP=~/.config/solana/id.json \
 *   WALLET_RT=./wallet-rt.json \
 *   VAULT_KEYPAIR_PATH=./vault-wallet.json \
 *   WHIRLPOOL_ADDRESS=Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
 *   yarn integration-test
 */

import {
  Keypair, PublicKey, Connection, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createTransferInstruction, getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ─── Protocol ────────────────────────────────────────────────────────
import { ILhProtocol } from "../protocol/interface";
import { OffchainLhProtocol } from "../protocol/offchain-emulator/index";
import { CertStatus, PositionStatus } from "../protocol/types";
import { computeQuote } from "../protocol/offchain-emulator/operations/pricing";

// ─── Orca tools ──────────────────────────────────────────────────────
import {
  WHIRLPOOL_ADDRESS, PYTH_SOL_USD_FEED, SOL_MINT, USDC_MINT,
} from "../clients/cli/config";
import {
  deriveOrcaPositionPda, deriveTickArrayPda, getTickArrayStartIndex,
  decodeWhirlpoolAccount, decodePositionAccount,
  alignTick, tickToSqrtPriceX64, sqrtPriceX64ToPrice,
  estimateLiquidity, buildOpenPositionIx, buildIncreaseLiquidityIx,
  deriveAta,
} from "../clients/cli/whirlpool-ix";
import {
  getOrCreateAta, buildWrapSolIxs, buildUnwrapSolIx,
  sendTxWithRetry, rpcWithRetry, formatSol, formatUsdc,
} from "../clients/cli/utils";
import {
  snapshotPosition, formatPositionSnapshot,
} from "../clients/cli/position-value";
import {
  snapshotWallet, formatWalletSnapshot, compareWalletSnapshots,
} from "../clients/cli/wallet-snapshot";

// ─── Integration modules ─────────────────────────────────────────────
import { TestConfig, MonitorSnapshot, TestResults } from "../tests/integration/types";
import { checkPrerequisites } from "../tests/integration/prerequisites";
import { initCleanupState, saveCleanupState, closeOrcaPosition } from "../tests/integration/cleanup";
import { computeSimulatedPayouts } from "../tests/integration/simulated-payouts";
import { runAssertions } from "../tests/integration/assertions";
import { ensureOutputDir, writeMonitorCsv, writeSimulatedPayoutsCsv, writePerformanceSummaryCsv } from "../tests/integration/csv-export";
import { printReport } from "../tests/integration/report";

// ─── Config ──────────────────────────────────────────────────────────

const CONFIG: TestConfig = {
  tenorSeconds: 1800,                    // 30 minutes
  rtDepositUsdc: 20_000_000,             // 20 USDC
  lpSol: 0.01,                           // 0.01 SOL
  lpUsdc: 2.0,                           // 2 USDC
  capUsdc: 5_000_000,                    // 5 USDC
  notionalUsdc: 10_000_000,              // 10 USDC
  barrierPct: parseFloat(process.env.BARRIER_PCT || "0.95"),
  monitorIntervalS: 60,
  tickWidth: 200,
  cluster: process.env.SOLANA_CLUSTER || "devnet",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendUsdcToVault(
  connection: Connection, sender: Keypair, vaultPubkey: PublicKey,
  usdcMint: PublicKey, amount: number,
): Promise<string> {
  const senderAta = getAssociatedTokenAddressSync(usdcMint, sender.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPubkey, true);
  const ix = createTransferInstruction(senderAta, vaultAta, sender.publicKey, amount);
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [sender]);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const startTime = new Date().toISOString();

  // ── Phase 0: Prerequisites ─────────────────────────────────────
  console.log("Phase 0: PREREQUISITES");
  const prereqs = await checkPrerequisites(CONFIG);
  for (const w of prereqs.warnings) console.log(`  WARN: ${w}`);
  if (!prereqs.passed) {
    for (const e of prereqs.errors) console.error(`  ERROR: ${e}`);
    process.exit(1);
  }
  const { lpWallet, rtWallet, vaultKeypair, connection, whirlpoolData: wp, entryPrice } = prereqs;
  console.log(`  SOL Price:    $${entryPrice.toFixed(2)}`);
  console.log(`  Est. cost:    $${prereqs.estimatedCostUsd.toFixed(2)}`);
  console.log(`  All checks passed.`);
  console.log();

  // Fresh data directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dataDir = path.resolve(__dirname, `../protocol/offchain-emulator/data/integration-${timestamp}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const outputDir = ensureOutputDir(dataDir);

  const cleanup = initCleanupState(dataDir);
  const protocol: ILhProtocol = new OffchainLhProtocol(connection, vaultKeypair, dataDir);
  const usdcMint = USDC_MINT;

  // ── Phase 1: Protocol Init ─────────────────────────────────────
  console.log("Phase 1: INITIALIZE PROTOCOL");
  try { await protocol.initPool(lpWallet, usdcMint, 8000); } catch (e: any) {
    if (!e.message.includes("already")) throw e;
  }
  try {
    await protocol.createTemplate(lpWallet, {
      templateId: 3, tenorSeconds: CONFIG.tenorSeconds, widthBps: 1000,
      severityPpm: 500_000, premiumFloorUsdc: 1_000, premiumCeilingUsdc: 1_000_000_000,
    });
  } catch (e: any) { if (!e.message.includes("already")) throw e; }
  await protocol.updateRegimeSnapshot(lpWallet, {
    sigmaPpm: 200_000, sigmaMaPpm: 180_000, stressFlag: false, carryBpsPerDay: 10,
  });
  console.log("  Pool, template, regime initialized.");
  console.log();

  // ── Phase 2: Snapshots ─────────────────────────────────────────
  console.log("Phase 2: INITIAL SNAPSHOTS");
  const w0_lp = await snapshotWallet(connection, lpWallet.publicKey, usdcMint, entryPrice);
  const w0_rt = await snapshotWallet(connection, rtWallet.publicKey, usdcMint, entryPrice);
  const initialLpSol = (await connection.getBalance(lpWallet.publicKey)) / LAMPORTS_PER_SOL;
  const initialRtSol = (await connection.getBalance(rtWallet.publicKey)) / LAMPORTS_PER_SOL;
  const initialVaultSol = (await connection.getBalance(vaultKeypair.publicKey)) / LAMPORTS_PER_SOL;
  console.log(formatWalletSnapshot(w0_lp, "LP"));
  console.log(formatWalletSnapshot(w0_rt, "RT"));
  console.log();

  // ── Phase 3: RT Deposits ───────────────────────────────────────
  console.log("Phase 3: RT DEPOSITS USDC");
  await getOrCreateAta(connection, vaultKeypair, usdcMint, vaultKeypair.publicKey);
  const depositTxSig = await sendUsdcToVault(connection, rtWallet, vaultKeypair.publicKey, usdcMint, CONFIG.rtDepositUsdc);
  const { shares } = await (protocol as OffchainLhProtocol).depositUsdc(rtWallet, CONFIG.rtDepositUsdc, depositTxSig);
  const poolAfterDeposit = await protocol.getPoolState();
  const navBefore = poolAfterDeposit.reservesUsdc / poolAfterDeposit.totalShares;
  console.log(`  ${formatUsdc(CONFIG.rtDepositUsdc)} USDC → ${shares} shares (NAV=${navBefore.toFixed(6)})`);
  console.log();

  // ── Phase 4: LP Opens Orca Position ────────────────────────────
  console.log("Phase 4: LP OPENS ORCA POSITION");
  const lowerTick = alignTick(wp.tickCurrentIndex - CONFIG.tickWidth, wp.tickSpacing, "down");
  const upperTick = alignTick(wp.tickCurrentIndex + CONFIG.tickWidth, wp.tickSpacing, "up");
  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(lpWallet.publicKey, positionMint);
  const lowerStart = getTickArrayStartIndex(lowerTick, wp.tickSpacing);
  const upperStart = getTickArrayStartIndex(upperTick, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, lowerStart);
  const [tickArrayUpper] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, upperStart);

  const solLamports = BigInt(Math.floor(CONFIG.lpSol * 1e9));
  const usdcMicro = BigInt(Math.floor(CONFIG.lpUsdc * 1e6));
  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);
  const liquidity = estimateLiquidity(solLamports, usdcMicro, wp.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const tokenMaxA = (solLamports * BigInt(110)) / BigInt(100);
  const tokenMaxB = (usdcMicro * BigInt(110)) / BigInt(100);

  const wsolAta = await getOrCreateAta(connection, lpWallet, SOL_MINT, lpWallet.publicKey);
  const lpUsdcAta = await getOrCreateAta(connection, lpWallet, wp.tokenMintB, lpWallet.publicKey);

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

  // Read ACTUAL position data from on-chain (real liquidity and deposited amounts)
  const orcaPosInfo = await connection.getAccountInfo(orcaPositionPda);
  if (!orcaPosInfo) throw new Error("Orca position PDA not found after opening");
  const orcaPosData = decodePositionAccount(Buffer.from(orcaPosInfo.data));
  const actualLiquidity = orcaPosData.liquidity;

  // Compute actual deposited amounts from the real on-chain liquidity
  const { estimateTokenAmounts: estAmounts } = await import("../clients/cli/position-value");
  const wpAfterOpen = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  const wpDataAfterOpen = decodeWhirlpoolAccount(Buffer.from(wpAfterOpen!.data));
  const actualAmounts = estAmounts(actualLiquidity, wpDataAfterOpen.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const actualSolLamports = actualAmounts.amountA;
  const actualUsdcMicro = actualAmounts.amountB;
  const actualEntryPrice = sqrtPriceX64ToPrice(wpDataAfterOpen.sqrtPrice);

  // Track LP SOL balance change as transaction cost
  const lpSolAfterOpen = (await connection.getBalance(lpWallet.publicKey)) / LAMPORTS_PER_SOL;
  const openPositionGasSol = initialLpSol - lpSolAfterOpen - Number(actualSolLamports) / 1e9;

  cleanup.positionMint = positionMint.toBase58();
  cleanup.positionOpen = true;
  cleanup.liquidity = actualLiquidity.toString();
  cleanup.tickLower = lowerTick;
  cleanup.tickUpper = upperTick;
  saveCleanupState(cleanup);
  console.log(`  Position opened: ${positionMint.toBase58().slice(0, 12)}...`);
  console.log(`  Ticks: [${lowerTick}, ${upperTick}]  Liquidity: ${actualLiquidity}`);
  console.log(`  Actual deposited: ${(Number(actualSolLamports)/1e9).toFixed(6)} SOL + ${(Number(actualUsdcMicro)/1e6).toFixed(6)} USDC`);
  console.log(`  Open position gas: ~${openPositionGasSol.toFixed(6)} SOL`);
  console.log();

  // ── Phase 5: Lock Position ─────────────────────────────────────
  console.log("Phase 5: LOCK POSITION");
  const vaultNftAta = await rpcWithRetry(() =>
    getOrCreateAta(connection, lpWallet, positionMint, vaultKeypair.publicKey)
  );
  const nftTx = new Transaction().add(createTransferInstruction(ownerPositionAta, vaultNftAta, lpWallet.publicKey, 1));
  await sendTxWithRetry(connection, nftTx, [lpWallet]);
  cleanup.nftInVault = true;
  saveCleanupState(cleanup);

  const priceE6 = Math.floor(actualEntryPrice * 1_000_000);
  await protocol.registerLockedPosition(lpWallet, {
    positionMint, whirlpool: WHIRLPOOL_ADDRESS,
    p0PriceE6: priceE6, depositedA: Number(actualSolLamports), depositedB: Number(actualUsdcMicro),
    lowerTick, upperTick, pythFeed: PYTH_SOL_USD_FEED,
  });
  cleanup.positionRegistered = true;
  saveCleanupState(cleanup);
  console.log("  Position locked and registered.");
  console.log();

  // ── Phase 6: Buy Certificate ───────────────────────────────────
  console.log("Phase 6: BUY CERTIFICATE");
  const barrierE6 = Math.floor(entryPrice * CONFIG.barrierPct * 1_000_000);
  const pool = await protocol.getPoolState();
  const regime = await protocol.getRegimeSnapshot();
  const template = await protocol.getTemplate(3);
  const preview = computeQuote(CONFIG.capUsdc, template, pool, regime);

  const premiumTxSig = await sendUsdcToVault(connection, lpWallet, vaultKeypair.publicKey, usdcMint, preview.premiumUsdc);
  const certResult = await (protocol as OffchainLhProtocol).buyCertificate(
    lpWallet,
    { positionMint, templateId: 3, capUsdc: CONFIG.capUsdc, lowerBarrierE6: barrierE6, notionalUsdc: CONFIG.notionalUsdc },
    premiumTxSig,
  );
  cleanup.certActive = true;
  saveCleanupState(cleanup);

  const poolAfterCert = await protocol.getPoolState();
  const utilBefore = pool.activeCapUsdc > 0 ? Math.floor((pool.activeCapUsdc * 10_000) / pool.reservesUsdc) : 0;
  const utilAfter = Math.floor((poolAfterCert.activeCapUsdc * 10_000) / poolAfterCert.reservesUsdc);
  const premiumPaid = certResult.premiumUsdc;
  const expiryTs = certResult.expiryTs;

  console.log(`  Premium: ${formatUsdc(premiumPaid)} USDC`);
  console.log(`  Cap: ${formatUsdc(CONFIG.capUsdc)} USDC  Barrier: $${(barrierE6 / 1e6).toFixed(4)}`);
  console.log(`  Expiry: ${new Date(expiryTs * 1000).toISOString()}`);
  console.log(`  Utilization: ${utilBefore} → ${utilAfter} bps`);
  console.log();

  const pv0 = await snapshotPosition(connection, positionMint, WHIRLPOOL_ADDRESS, actualSolLamports, actualUsdcMicro);
  console.log(formatPositionSnapshot(pv0, "Position at Entry"));
  console.log();

  // ── Phase 7: Monitor ───────────────────────────────────────────
  console.log("Phase 7: MONITORING");
  const monitorSnapshots: MonitorSnapshot[] = [];
  const startNow = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, expiryTs - startNow);

  for (let elapsed = 0; elapsed < waitSeconds; elapsed += CONFIG.monitorIntervalS) {
    const remaining = waitSeconds - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(CONFIG.monitorIntervalS, remaining) * 1000);

    try {
      const snap = await rpcWithRetry(() =>
        snapshotPosition(connection, positionMint, WHIRLPOOL_ADDRESS, actualSolLamports, actualUsdcMicro)
      );
      const minutesLeft = Math.max(0, (expiryTs - Math.floor(Date.now() / 1000)) / 60);
      console.log(
        `  [${new Date().toISOString().slice(11, 19)}] ` +
        `Price=$${snap.price.toFixed(4)} ` +
        `Value=$${snap.valueUsd.toFixed(8)} ` +
        `Hold=$${snap.holdValueUsd.toFixed(8)} ` +
        `IL=$${snap.ilUsd.toFixed(8)} (${snap.ilPct.toFixed(6)}%) ` +
        `(${minutesLeft.toFixed(0)}min left)`
      );
      monitorSnapshots.push({
        timestamp: snap.timestamp, elapsedS: elapsed + CONFIG.monitorIntervalS,
        solPrice: snap.price, positionValueUsd: snap.valueUsd, holdValueUsd: snap.holdValueUsd,
        ilUsd: snap.ilUsd, ilPct: snap.ilPct, isInRange: snap.isInRange,
        tickCurrent: snap.tickCurrent, minutesRemaining: minutesLeft,
      });
    } catch (e: any) {
      console.log(`  [Monitor] Error: ${e.message}`);
    }
  }
  console.log();

  // ── Phase 8: Settlement ────────────────────────────────────────
  console.log("Phase 8: SETTLEMENT");
  const timeToExpiry = expiryTs - Math.floor(Date.now() / 1000);
  if (timeToExpiry > 0) {
    console.log(`  Waiting ${timeToExpiry}s for expiry...`);
    await sleep((timeToExpiry + 5) * 1000);
  }

  const pv1 = await rpcWithRetry(() =>
    snapshotPosition(connection, positionMint, WHIRLPOOL_ADDRESS, actualSolLamports, actualUsdcMicro)
  );
  console.log(formatPositionSnapshot(pv1, "Position at Settlement"));

  const settleResult = await protocol.settleCertificate(lpWallet, positionMint);
  cleanup.certActive = false;
  saveCleanupState(cleanup);

  const certOutcome = settleResult.payout > 0 ? "SETTLED" : "EXPIRED";
  console.log(`  Outcome: ${certOutcome}  Payout: ${formatUsdc(settleResult.payout)} USDC`);
  console.log(`  Settlement price: $${(settleResult.settlementPriceE6 / 1e6).toFixed(4)}`);
  console.log();

  // Capture pool state BEFORE withdrawal (for assertions) — deep copy to avoid mutation
  const poolBeforeWithdraw = JSON.parse(JSON.stringify(await protocol.getPoolState()));

  // ── Phase 9: Cleanup ───────────────────────────────────────────
  console.log("Phase 9: CLEANUP");
  await protocol.releasePosition(lpWallet, positionMint);
  cleanup.nftInVault = false;
  cleanup.positionRegistered = false;
  saveCleanupState(cleanup);
  console.log("  Position released to LP.");

  let rtReturned = 0;
  try {
    const result = await protocol.withdrawUsdc(rtWallet, shares);
    rtReturned = result.usdcReturned;
    console.log(`  RT withdrew ${formatUsdc(rtReturned)} USDC`);
  } catch (e: any) {
    console.log(`  RT withdrawal: ${e.message}`);
  }

  // Close Orca position
  try {
    await closeOrcaPosition(connection, lpWallet, positionMint, wp, actualLiquidity, lowerTick, upperTick);
    cleanup.positionOpen = false;
    saveCleanupState(cleanup);
    console.log("  Orca position closed, funds recovered.");
  } catch (e: any) {
    console.log(`  Position close failed (can retry manually): ${e.message}`);
  }
  console.log();

  // ── Phase 10: Report ───────────────────────────────────────────
  const settlementPrice = pv1.price;
  const poolFinal = await protocol.getPoolState();
  const navAfter = poolFinal.totalShares > 0 ? poolFinal.reservesUsdc / poolFinal.totalShares : 1;

  const finalLpSol = (await connection.getBalance(lpWallet.publicKey)) / LAMPORTS_PER_SOL;
  const finalRtSol = (await connection.getBalance(rtWallet.publicKey)) / LAMPORTS_PER_SOL;
  const finalVaultSol = (await connection.getBalance(vaultKeypair.publicKey)) / LAMPORTS_PER_SOL;
  const totalGasSol = (initialLpSol - finalLpSol) + (initialRtSol - finalRtSol) + (initialVaultSol - finalVaultSol);

  // Check position final state
  let posProtectedByCleared = true;
  let posReleased = true;
  try {
    const posState = await protocol.getPositionState(positionMint);
    posProtectedByCleared = posState.protectedBy === null;
    posReleased = posState.status === PositionStatus.RELEASED;
  } catch { /* position may not be found after release */ }

  // Simulated payouts
  const simulatedPayouts = computeSimulatedPayouts({
    entryPrice: actualEntryPrice, barrierPrice: barrierE6 / 1e6, capUsdc: CONFIG.capUsdc,
    premiumUsdc: premiumPaid, liquidity: actualLiquidity, tickLower: lowerTick, tickUpper: upperTick,
    rtDepositUsdc: CONFIG.rtDepositUsdc,
  });

  const positionPnl = pv1.valueUsd - pv0.valueUsd;
  const payoutUsd = settleResult.payout / 1e6;
  const premiumUsd = premiumPaid / 1e6;

  const results: TestResults = {
    config: CONFIG,
    startTime,
    endTime: new Date().toISOString(),
    lpPerformance: {
      entryPrice: actualEntryPrice, settlementPrice, priceChangePct: ((settlementPrice - actualEntryPrice) / actualEntryPrice) * 100,
      positionEntryValueUsd: pv0.valueUsd, positionSettlementValueUsd: pv1.valueUsd,
      positionPnlUsd: positionPnl, positionPnlPct: pv0.valueUsd > 0 ? (positionPnl / pv0.valueUsd) * 100 : 0,
      holdValueUsd: pv1.holdValueUsd, ilUsd: pv1.ilUsd, ilPct: pv1.ilPct,
      premiumPaidUsdc: premiumPaid, premiumPaidUsd: premiumUsd,
      capUsdc: CONFIG.capUsdc, barrierPrice: barrierE6 / 1e6,
      payoutUsdc: settleResult.payout, payoutUsd, certOutcome,
      netHedgedPnlUsd: positionPnl + payoutUsd - premiumUsd,
      unhedgedPnlUsd: positionPnl,
      hedgeBenefitUsd: payoutUsd - premiumUsd,
    },
    rtPerformance: {
      capitalDepositedUsdc: CONFIG.rtDepositUsdc, sharesReceived: shares,
      premiumIncomeUsdc: premiumPaid, claimsPaidUsdc: settleResult.payout,
      navPerShareBefore: navBefore, navPerShareAfter: navAfter,
      usdcReturnedUsdc: rtReturned,
      returnOnCapitalPct: CONFIG.rtDepositUsdc > 0
        ? ((rtReturned - CONFIG.rtDepositUsdc) / CONFIG.rtDepositUsdc) * 100 : 0,
    },
    matchmaking: {
      poolUtilizationBeforeBps: utilBefore, poolUtilizationAfterBps: utilAfter,
      premiumBreakdown: preview, templateParams: template, regimeParams: regime,
    },
    monitorSnapshots,
    simulatedPayouts,
    costTracking: {
      initialLpSol, initialRtSol, initialVaultSol,
      finalLpSol, finalRtSol, finalVaultSol,
      totalSolSpentOnGas: Math.max(0, totalGasSol),
      totalGasCostUsd: Math.max(0, totalGasSol) * settlementPrice,
    },
    assertions: runAssertions({
      poolBefore: poolAfterDeposit, poolAfter: poolBeforeWithdraw,
      rtDeposit: CONFIG.rtDepositUsdc, premiumUsdc: premiumPaid,
      payoutUsdc: settleResult.payout, rtShares: shares, rtReturned,
      certState: settleResult.state, positionProtectedByCleared: posProtectedByCleared,
      positionReleased: posReleased, entryPriceE6: priceE6,
      conservativePriceE6: settleResult.conservativePriceE6,
      simulatedPayouts, capUsdc: CONFIG.capUsdc,
    }),
  };

  // Print report
  printReport(results);

  // Write CSVs
  const csvMonitor = writeMonitorCsv(outputDir, monitorSnapshots);
  const csvPayouts = writeSimulatedPayoutsCsv(outputDir, simulatedPayouts);
  const csvSummary = writePerformanceSummaryCsv(outputDir, results);

  console.log("── Output Files ──");
  console.log(`  Monitor:    ${csvMonitor}`);
  console.log(`  Payouts:    ${csvPayouts}`);
  console.log(`  Summary:    ${csvSummary}`);
  console.log(`  Audit log:  ${path.join(dataDir, "audit.jsonl")}`);
  console.log(`  State:      ${path.join(dataDir, "protocol-state.json")}`);
  console.log();

  const passed = results.assertions.filter((a) => a.passed).length;
  const total = results.assertions.length;
  console.log(`Integration test complete. ${passed}/${total} assertions passed.`);

  if (passed < total) process.exit(1);
}

main().catch((err) => {
  console.error("\nIntegration test failed:", err);
  process.exit(1);
});
