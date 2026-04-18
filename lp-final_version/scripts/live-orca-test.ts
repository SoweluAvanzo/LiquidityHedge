#!/usr/bin/env ts-node
/**
 * live-orca-test.ts — Open a REAL Orca Whirlpool concentrated liquidity
 * position on Solana, register it in the off-chain protocol emulator,
 * buy a corridor hedge certificate, monitor the position, and settle
 * at expiry.
 *
 * WARNING: This script uses REAL funds on Solana mainnet/devnet.
 * Default amounts are small (0.01 SOL + 2 USDC) but you will spend
 * real SOL on transaction fees and real tokens on the position.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://mainnet.helius-rpc.com/?api-key=...  \
 *   WALLET_LP=~/.config/solana/id.json                               \
 *   WALLET_RT=./wallet-rt.json                                       \
 *   BIRDEYE_API_KEY=ed577a4a6a4f480fa659b4f18673e4b1                 \
 *   npx ts-node scripts/live-orca-test.ts
 *
 * Optional env vars:
 *   WHIRLPOOL_ADDRESS   - defaults to mainnet SOL/USDC
 *   TENOR_SECONDS       - defaults to 1200 (20 min)
 */

import "dotenv/config";

import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";

// ── Orca tools ──────────────────────────────────────────────────────
import {
  decodeWhirlpoolAccount,
  decodePositionAccount,
  sqrtPriceX64ToPrice,
  tickToSqrtPriceX64,
  alignTick,
  estimateLiquidity,
  buildOpenPositionIx,
  buildIncreaseLiquidityIx,
  buildWrapSolIxs,
  buildUnwrapSolIx,
  deriveAta,
} from "../protocol-src/clients/whirlpool-ix";
import {
  estimateTokenAmounts,
  positionValueUsd,
} from "../protocol-src/utils/position-value";

// ── Chain config ────────────────────────────────────────────────────
import {
  MAINNET_USDC_MINT,
  SOL_MINT,
  MAINNET_WHIRLPOOL,
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  tickArrayStartIndex,
} from "../protocol-src/clients/config";

// ── Birdeye ─────────────────────────────────────────────────────────
import {
  fetchOHLCV,
  computeVolatility,
} from "../protocol-src/clients/birdeye";

// ── Protocol emulator ───────────────────────────────────────────────
import {
  OffchainLhProtocol,
  CertificateStatus,
} from "../protocol-src/index";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_TEMPLATE,
} from "../protocol-src/config/templates";

// =====================================================================
// Configuration
// =====================================================================

const TENOR_SECONDS = parseInt(process.env.TENOR_SECONDS || "1200", 10);
const LP_SOL = 0.01;
const LP_USDC = 2.0;
const RT_DEPOSIT_USDC = 8_000_000; // 8 USDC (micro-USDC)
const TICK_WIDTH = 200;
const MONITOR_INTERVAL_S = 60;

// =====================================================================
// Helpers
// =====================================================================

function loadKeypair(envVar: string, fallback?: string): Keypair {
  const p = process.env[envVar] || fallback;
  if (!p) throw new Error(`${envVar} env var is required`);
  const resolved = p.replace(/^~/, process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatUsdc(micro: number): string {
  return (micro / 1_000_000).toFixed(6);
}

function formatSol(lamports: number | bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
}

/**
 * Send a transaction with retry on blockhash expiry (up to 3 attempts).
 */
async function sendTxWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  maxRetries: number = 3,
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: "confirmed",
      });
      return sig;
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isBlockhash =
        msg.includes("blockhash") && msg.includes("not found");
      if (isBlockhash && attempt < maxRetries) {
        console.log(
          `  Blockhash expired, refreshing and retrying (${attempt}/${maxRetries})...`,
        );
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        continue;
      }
      throw err;
    }
  }
  throw new Error("sendTxWithRetry: max retries exceeded");
}

// =====================================================================
// Main
// =====================================================================

async function main() {
  // ═══════════════════════════════════════════════════════════════════
  // Phase 0: Setup
  // ═══════════════════════════════════════════════════════════════════

  console.log();
  console.log("================================================================");
  console.log("  WARNING: This script uses REAL funds on Solana.");
  console.log("  Amounts: 0.01 SOL + 2 USDC (+ transaction fees).");
  console.log("  Press Ctrl+C within 5 seconds to abort.");
  console.log("================================================================");
  console.log();
  await sleep(5000);

  const rpcUrl =
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  const lpWallet = loadKeypair("WALLET_LP", "~/.config/solana/id.json");
  const rtWallet = loadKeypair("WALLET_RT");
  const birdeyeKey = process.env.BIRDEYE_API_KEY || "";

  const whirlpoolAddress = process.env.WHIRLPOOL_ADDRESS
    ? new PublicKey(process.env.WHIRLPOOL_ADDRESS)
    : MAINNET_WHIRLPOOL;

  const usdcMint = MAINNET_USDC_MINT;

  // Print balances
  const lpSolBal = await connection.getBalance(lpWallet.publicKey);
  const rtSolBal = await connection.getBalance(rtWallet.publicKey);
  let lpUsdcBal = 0;
  let rtUsdcBal = 0;
  try {
    const lpAta = getAssociatedTokenAddressSync(usdcMint, lpWallet.publicKey);
    lpUsdcBal = Number((await getAccount(connection, lpAta)).amount);
  } catch { /* no ATA yet */ }
  try {
    const rtAta = getAssociatedTokenAddressSync(usdcMint, rtWallet.publicKey);
    rtUsdcBal = Number((await getAccount(connection, rtAta)).amount);
  } catch { /* no ATA yet */ }

  console.log("PHASE 0: SETUP");
  console.log(`  RPC:         ${rpcUrl.slice(0, 60)}...`);
  console.log(`  LP Wallet:   ${lpWallet.publicKey.toBase58()}`);
  console.log(`  RT Wallet:   ${rtWallet.publicKey.toBase58()}`);
  console.log(`  Whirlpool:   ${whirlpoolAddress.toBase58()}`);
  console.log(`  Tenor:       ${TENOR_SECONDS}s (${(TENOR_SECONDS / 60).toFixed(0)} min)`);
  console.log(`  LP Balance:  ${formatSol(lpSolBal)} SOL | ${formatUsdc(lpUsdcBal)} USDC`);
  console.log(`  RT Balance:  ${formatSol(rtSolBal)} SOL | ${formatUsdc(rtUsdcBal)} USDC`);
  console.log();

  // Minimum balance checks
  const minLpSol = 0.05 * LAMPORTS_PER_SOL; // 0.05 SOL for fees + position
  const minRtUsdc = RT_DEPOSIT_USDC;
  if (lpSolBal < minLpSol) {
    throw new Error(
      `LP wallet needs at least 0.05 SOL (has ${formatSol(lpSolBal)}). ` +
      `Fund it before running this script.`,
    );
  }
  if (lpUsdcBal < LP_USDC * 1_000_000) {
    throw new Error(
      `LP wallet needs at least ${LP_USDC} USDC (has ${formatUsdc(lpUsdcBal)}). ` +
      `Fund it before running this script.`,
    );
  }
  if (rtUsdcBal < minRtUsdc) {
    throw new Error(
      `RT wallet needs at least ${formatUsdc(minRtUsdc)} USDC (has ${formatUsdc(rtUsdcBal)}). ` +
      `Fund it before running this script.`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1: Fetch market state
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 1: FETCH MARKET STATE");

  const wpInfo = await connection.getAccountInfo(whirlpoolAddress);
  if (!wpInfo) throw new Error("Whirlpool account not found: " + whirlpoolAddress.toBase58());
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));
  const entryPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);
  const entryPriceE6 = Math.floor(entryPrice * 1_000_000);

  console.log(`  Current SOL price: $${entryPrice.toFixed(4)}`);
  console.log(`  Tick current:      ${wp.tickCurrentIndex}`);
  console.log(`  Tick spacing:      ${wp.tickSpacing}`);
  console.log(`  Fee rate:          ${wp.feeRate / 100}%`);

  // Birdeye volatility
  let sigmaPpm = 650_000;  // default 65% annualized
  let sigma7dPpm = 650_000;
  let stressFlag = false;
  if (birdeyeKey) {
    try {
      console.log("  Fetching Birdeye OHLCV (30d, 15m)...");
      const candles = await fetchOHLCV(birdeyeKey, 30, "15m");
      if (candles.length > 10) {
        const vol = computeVolatility(candles, "15m");
        sigmaPpm = vol.sigmaPpm;
        sigma7dPpm = vol.sigma7dPpm;
        stressFlag = vol.stressFlag;
        console.log(`  30d vol:      ${(sigmaPpm / 10_000).toFixed(1)}% annualized`);
        console.log(`  7d vol:       ${(sigma7dPpm / 10_000).toFixed(1)}% annualized`);
        console.log(`  Stress flag:  ${stressFlag}`);
      } else {
        console.log("  Birdeye returned few candles, using default vol.");
      }
    } catch (e: any) {
      console.log(`  Birdeye fetch failed: ${e.message}. Using default vol.`);
    }
  } else {
    console.log("  No BIRDEYE_API_KEY set, using default vol (65%).");
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: Open Orca position
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 2: OPEN ORCA POSITION");

  const lowerTick = alignTick(
    wp.tickCurrentIndex - TICK_WIDTH,
    wp.tickSpacing,
    "down",
  );
  const upperTick = alignTick(
    wp.tickCurrentIndex + TICK_WIDTH,
    wp.tickSpacing,
    "up",
  );

  console.log(`  Tick range:  [${lowerTick}, ${upperTick}]`);

  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(lpWallet.publicKey, positionMint);

  const lowerStart = tickArrayStartIndex(lowerTick, wp.tickSpacing);
  const upperStart = tickArrayStartIndex(upperTick, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(whirlpoolAddress, lowerStart);
  const [tickArrayUpper] = deriveTickArrayPda(whirlpoolAddress, upperStart);

  const solLamports = BigInt(Math.floor(LP_SOL * 1e9));
  const usdcMicro = BigInt(Math.floor(LP_USDC * 1e6));
  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);
  const liquidity = estimateLiquidity(
    solLamports,
    usdcMicro,
    wp.sqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper,
  );
  const tokenMaxA = (solLamports * 110n) / 100n;
  const tokenMaxB = (usdcMicro * 110n) / 100n;

  console.log(`  Position mint:  ${positionMint.toBase58()}`);
  console.log(`  SOL deposit:    ${formatSol(solLamports)}`);
  console.log(`  USDC deposit:   ${formatUsdc(Number(usdcMicro))}`);
  console.log(`  Est. liquidity: ${liquidity.toString()}`);

  // Ensure WSOL and USDC ATAs exist
  const wsolAta = deriveAta(lpWallet.publicKey, SOL_MINT);
  const lpUsdcAta = getAssociatedTokenAddressSync(usdcMint, lpWallet.publicKey);

  // Build transaction: open position + wrap SOL + add liquidity + unwrap
  const tx1 = new Transaction();

  tx1.add(
    buildOpenPositionIx({
      funder: lpWallet.publicKey,
      owner: lpWallet.publicKey,
      positionPda: orcaPositionPda,
      positionBump,
      positionMint,
      positionTokenAccount: ownerPositionAta,
      whirlpool: whirlpoolAddress,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
    }),
  );

  tx1.add(...buildWrapSolIxs(lpWallet.publicKey, wsolAta, tokenMaxA));

  tx1.add(
    buildIncreaseLiquidityIx({
      whirlpool: whirlpoolAddress,
      positionAuthority: lpWallet.publicKey,
      positionPda: orcaPositionPda,
      positionTokenAccount: ownerPositionAta,
      tokenOwnerAccountA: wsolAta,
      tokenOwnerAccountB: lpUsdcAta,
      tokenVaultA: wp.tokenVaultA,
      tokenVaultB: wp.tokenVaultB,
      tickArrayLower,
      tickArrayUpper,
      liquidityAmount: liquidity,
      tokenMaxA,
      tokenMaxB,
    }),
  );

  tx1.add(buildUnwrapSolIx(wsolAta, lpWallet.publicKey));

  console.log("  Sending open position transaction...");
  try {
    const sig1 = await sendTxWithRetry(connection, tx1, [
      lpWallet,
      positionMintKp,
    ]);
    console.log(`  Position opened! Tx: ${sig1.slice(0, 20)}...`);
  } catch (err: any) {
    console.error("  FAILED to open Orca position:", err.message);
    throw err;
  }

  // Verify position on-chain (retry with backoff — account may take a moment to finalize)
  const [orcaPosVerifyPda] = deriveOrcaPositionPda(positionMint);
  let posAcct: Awaited<ReturnType<typeof connection.getAccountInfo>> = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    posAcct = await connection.getAccountInfo(orcaPosVerifyPda);
    if (posAcct) break;
    console.log(`  Waiting for position account (attempt ${attempt}/5)...`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!posAcct) {
    throw new Error("Position account not found after 5 attempts — check the transaction on-chain");
  }
  const posData = decodePositionAccount(Buffer.from(posAcct.data));
  console.log(`  Verified on-chain: liquidity=${posData.liquidity}, ticks=[${posData.tickLowerIndex}, ${posData.tickUpperIndex}]`);

  // Compute entry value
  const { amountA: entryAmtA, amountB: entryAmtB } = estimateTokenAmounts(
    posData.liquidity,
    wp.sqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper,
  );
  const entryValueUsd = positionValueUsd(entryAmtA, entryAmtB, entryPrice);
  const entryValueE6 = Math.floor(entryValueUsd * 1_000_000);
  console.log(`  Entry value:    $${entryValueUsd.toFixed(6)}`);

  // Normalize on-chain liquidity to a scale compatible with the human-readable
  // clPositionValue(S, L, pL, pU) function used by the protocol emulator.
  // unitValue = V(S_0) when L=1; normalizedL = entryValueUsd / unitValue.
  const { clPositionValue } = await import("../protocol-src/utils/position-value");
  const pL_usd = entryPrice * (1 - DEFAULT_TEMPLATE.widthBps / 10_000);
  const pU_usd = entryPrice * (1 + DEFAULT_TEMPLATE.widthBps / 10_000);
  const unitValue = clPositionValue(entryPrice, 1.0, pL_usd, pU_usd);
  const normalizedL = unitValue > 0 ? entryValueUsd / unitValue : 1;
  console.log(`  On-chain L:     ${posData.liquidity.toString()}`);
  console.log(`  Normalized L:   ${normalizedL.toFixed(2)} (for emulator CL math)`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3: Initialize protocol + buy certificate
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 3: INITIALIZE PROTOCOL + BUY CERTIFICATE");

  const protocol = new OffchainLhProtocol();

  // Init pool
  protocol.initPool("admin", {
    ...DEFAULT_POOL_CONFIG,
    uMaxBps: 8000, // 80% utilization for demo
  });
  console.log("  Pool initialized (uMax=80%)");

  // RT deposits
  protocol.depositUsdc(rtWallet.publicKey.toBase58(), RT_DEPOSIT_USDC);
  console.log(`  RT deposited ${formatUsdc(RT_DEPOSIT_USDC)} USDC`);

  // Create template for the demo tenor
  const demoTemplate = {
    ...DEFAULT_TEMPLATE,
    templateId: 10,
    tenorSeconds: TENOR_SECONDS,
  };
  protocol.createTemplate("admin", demoTemplate);
  console.log(`  Template 10 created (tenor=${TENOR_SECONDS}s)`);

  // Update regime with real Birdeye volatility
  protocol.updateRegimeSnapshot("risk-svc", {
    sigmaPpm,
    sigma7dPpm,
    stressFlag,
    carryBpsPerDay: 5,
    ivRvRatio: 1.08,
  });
  console.log(`  Regime updated (sigma=${(sigmaPpm / 10_000).toFixed(1)}%)`);

  // Register position in emulator using real on-chain data
  const positionMintStr = positionMint.toBase58();
  protocol.registerLockedPosition(lpWallet.publicKey.toBase58(), {
    positionMint: positionMintStr,
    entryPriceE6,
    lowerTick,
    upperTick,
    liquidity: BigInt(Math.round(normalizedL)),
    entryValueE6,
  });
  console.log("  Position registered in emulator");

  // Buy certificate
  const buyResult = protocol.buyCertificate(
    lpWallet.publicKey.toBase58(),
    {
      positionMint: positionMintStr,
      templateId: 10,
    },
  );

  const premiumPaid = buyResult.premiumUsdc;
  const expiryTs = buyResult.expiryTs;

  console.log(`  Certificate purchased!`);
  console.log(`    Premium:  ${formatUsdc(premiumPaid)} USDC`);
  console.log(`    Cap:      ${formatUsdc(buyResult.capUsdc)} USDC`);
  console.log(`    Barrier:  $${(buyResult.barrierE6 / 1e6).toFixed(4)}`);
  console.log(`    Expiry:   ${new Date(expiryTs * 1000).toISOString()}`);
  console.log(`    Markup:   ${buyResult.effectiveMarkup.toFixed(4)}`);
  console.log(`    FV:       ${formatUsdc(buyResult.fairValueUsdc)} USDC`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4: Monitor
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 4: MONITOR (every 60s until expiry)");
  console.log("  Press Ctrl+C to skip monitoring and settle immediately.");
  console.log();

  const startNow = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, expiryTs - startNow);

  for (let elapsed = 0; elapsed < waitSeconds; elapsed += MONITOR_INTERVAL_S) {
    const remaining = waitSeconds - elapsed;
    if (remaining <= 0) break;
    const waitTime = Math.min(MONITOR_INTERVAL_S, remaining) * 1000;
    await sleep(waitTime);

    try {
      // Fetch current whirlpool state
      const wpNow = await connection.getAccountInfo(whirlpoolAddress);
      if (!wpNow) continue;
      const wpData = decodeWhirlpoolAccount(Buffer.from(wpNow.data));
      const currentPrice = sqrtPriceX64ToPrice(wpData.sqrtPrice);

      // Compute current position value
      const { amountA: nowA, amountB: nowB } = estimateTokenAmounts(
        posData.liquidity,
        wpData.sqrtPrice,
        sqrtPriceLower,
        sqrtPriceUpper,
      );
      const currentValueUsd = positionValueUsd(nowA, nowB, currentPrice);
      const unrealizedPnl = currentValueUsd - entryValueUsd;
      const isInRange =
        wpData.tickCurrentIndex >= lowerTick &&
        wpData.tickCurrentIndex < upperTick;
      const minutesLeft = Math.max(
        0,
        (expiryTs - Math.floor(Date.now() / 1000)) / 60,
      );

      console.log(
        `  [${new Date().toISOString()}] ` +
        `Price=$${currentPrice.toFixed(2)} ` +
        `Value=$${currentValueUsd.toFixed(6)} ` +
        `PnL=${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(6)} ` +
        `InRange=${isInRange} ` +
        `(${minutesLeft.toFixed(0)}min left)`,
      );
    } catch (e: any) {
      console.log(`  [Monitor] Error: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5: Settle
  // ═══════════════════════════════════════════════════════════════════

  console.log();
  console.log("PHASE 5: SETTLEMENT");

  // Wait for expiry if needed
  const timeToExpiry = expiryTs - Math.floor(Date.now() / 1000);
  if (timeToExpiry > 0) {
    console.log(`  Waiting ${timeToExpiry}s for certificate expiry...`);
    await sleep((timeToExpiry + 2) * 1000);
  }

  // Fetch final whirlpool price
  const wpFinal = await connection.getAccountInfo(whirlpoolAddress);
  if (!wpFinal) throw new Error("Whirlpool account not found at settlement");
  const wpSettleData = decodeWhirlpoolAccount(Buffer.from(wpFinal.data));
  const settlementPrice = sqrtPriceX64ToPrice(wpSettleData.sqrtPrice);
  const settlementPriceE6 = Math.floor(settlementPrice * 1_000_000);

  // Compute final position value
  const { amountA: finalA, amountB: finalB } = estimateTokenAmounts(
    posData.liquidity,
    wpSettleData.sqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper,
  );
  const finalValueUsd = positionValueUsd(finalA, finalB, settlementPrice);
  const positionPnl = finalValueUsd - entryValueUsd;

  console.log(`  Settlement price: $${settlementPrice.toFixed(4)}`);
  console.log(`  Final position value: $${finalValueUsd.toFixed(6)}`);
  console.log(`  Position PnL: ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(6)}`);

  // Estimate accrued LP trading fees (simulated: ~0.5%/day of position value)
  const tenorDays = TENOR_SECONDS / 86_400;
  const estimatedFees = Math.floor(entryValueE6 * 0.005 * tenorDays);

  // Settle in emulator
  const settleResult = protocol.settleCertificate(
    "settler",
    positionMintStr,
    settlementPriceE6,
    estimatedFees,
  );

  const payoutUsdc = settleResult.payoutUsdc;
  const rtFeeIncome = settleResult.rtFeeIncomeUsdc;
  const outcome =
    settleResult.state === CertificateStatus.Settled
      ? "PAYOUT TRIGGERED"
      : "EXPIRED (no payout)";

  console.log(`  Outcome:      ${outcome}`);
  console.log(`  Payout:       ${formatUsdc(payoutUsdc)} USDC`);
  console.log(`  Fee split:    ${formatUsdc(rtFeeIncome)} USDC (RT income)`);
  console.log(`  Cert state:   ${settleResult.state}`);

  // Compute PnL breakdown
  const feesUsd = estimatedFees / 1_000_000;
  const payoutUsd = payoutUsdc / 1_000_000;
  const premiumUsd = premiumPaid / 1_000_000;
  const feeSplitUsd = rtFeeIncome / 1_000_000;
  const protocolFeeBps = DEFAULT_POOL_CONFIG.protocolFeeBps;

  const lpHedgedPnl =
    positionPnl +
    feesUsd * (1 - DEFAULT_POOL_CONFIG.feeSplitRate) -
    premiumUsd +
    payoutUsd;
  const lpUnhedgedPnl = positionPnl + feesUsd;
  const rtPnl =
    premiumUsd * (1 - protocolFeeBps / 10_000) + feeSplitUsd - payoutUsd;

  console.log();
  console.log(`  -- LP PnL (Hedged) --`);
  console.log(`    Position PnL:    ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(6)}`);
  console.log(`    Fees (net):      +$${(feesUsd * (1 - DEFAULT_POOL_CONFIG.feeSplitRate)).toFixed(6)}`);
  console.log(`    Premium cost:    -$${premiumUsd.toFixed(6)}`);
  console.log(`    Hedge payout:    +$${payoutUsd.toFixed(6)}`);
  console.log(`    NET:             ${lpHedgedPnl >= 0 ? "+" : ""}$${lpHedgedPnl.toFixed(6)}`);
  console.log();
  console.log(`  -- LP PnL (Unhedged, counterfactual) --`);
  console.log(`    Position PnL:    ${lpUnhedgedPnl >= 0 ? "+" : ""}$${lpUnhedgedPnl.toFixed(6)}`);
  console.log();
  console.log(`  -- RT PnL --`);
  console.log(`    Premium income:  +$${(premiumUsd * (1 - protocolFeeBps / 10_000)).toFixed(6)}`);
  console.log(`    Fee split:       +$${feeSplitUsd.toFixed(6)}`);
  console.log(`    Payout outflow:  -$${payoutUsd.toFixed(6)}`);
  console.log(`    NET:             ${rtPnl >= 0 ? "+" : ""}$${rtPnl.toFixed(6)}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 6: Cleanup
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 6: CLEANUP");

  // Release position in emulator
  protocol.releasePosition(lpWallet.publicKey.toBase58(), positionMintStr);
  console.log("  Position released in emulator");

  // RT withdraws
  try {
    const pool = protocol.getPoolState();
    if (pool && pool.totalShares > 0) {
      const { usdcReturned } = protocol.withdrawUsdc(
        rtWallet.publicKey.toBase58(),
        pool.totalShares,
      );
      console.log(`  RT withdrew ${formatUsdc(usdcReturned)} USDC`);
    }
  } catch (e: any) {
    console.log(`  RT withdrawal: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Final report
  // ═══════════════════════════════════════════════════════════════════

  const priceChange = ((settlementPrice - entryPrice) / entryPrice) * 100;
  const hedgeBenefit = lpHedgedPnl - lpUnhedgedPnl;

  console.log();
  console.log("================================================================");
  console.log("  FINAL REPORT");
  console.log("================================================================");
  console.log();
  console.log(`  SOL Price:     $${entryPrice.toFixed(4)} -> $${settlementPrice.toFixed(4)} (${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%)`);
  console.log(`  Tenor:         ${TENOR_SECONDS}s (${(TENOR_SECONDS / 60).toFixed(0)} min)`);
  console.log(`  Position:      ${positionMint.toBase58()}`);
  console.log(`  Entry value:   $${entryValueUsd.toFixed(6)}`);
  console.log(`  Final value:   $${finalValueUsd.toFixed(6)}`);
  console.log(`  Position PnL:  ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(6)}`);
  console.log();
  console.log(`  LP hedged PnL:   ${lpHedgedPnl >= 0 ? "+" : ""}$${lpHedgedPnl.toFixed(6)}`);
  console.log(`  LP unhedged PnL: ${lpUnhedgedPnl >= 0 ? "+" : ""}$${lpUnhedgedPnl.toFixed(6)}`);
  console.log(`  Hedge benefit:   ${hedgeBenefit >= 0 ? "+" : ""}$${hedgeBenefit.toFixed(6)}`);
  console.log(`  RT PnL:          ${rtPnl >= 0 ? "+" : ""}$${rtPnl.toFixed(6)}`);
  console.log();
  console.log(`  NOTE: The Orca position NFT is still live on-chain.`);
  console.log(`  You can close it manually or leave it to accrue fees.`);
  console.log();
  console.log("  Demo complete.");
}

// ── Run with global error handler ──────────────────────────────────

main().catch((err) => {
  console.error();
  console.error("FATAL ERROR:", err.message || err);
  if (err.logs) {
    console.error("Transaction logs:");
    for (const line of err.logs) {
      console.error("  ", line);
    }
  }
  process.exit(1);
});
