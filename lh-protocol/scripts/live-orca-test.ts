#!/usr/bin/env ts-node
/**
 * live-orca-test.ts — Open a REAL Orca Whirlpool concentrated liquidity
 * position on Solana, register it in the off-chain protocol emulator,
 * buy a Liquidity Hedge certificate, monitor the position, and settle
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
 *   BIRDEYE_API_KEY=<your-key>                                      \
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
  deriveAta,
} from "../protocol-src/market-data/decoder";
import {
  buildOpenPositionIx,
  buildIncreaseLiquidityIx,
  buildWrapSolIxs,
  buildUnwrapSolIx,
} from "../protocol-src/position-escrow/orca-adapter";
import {
  estimateTokenAmounts,
  positionValueUsd,
} from "../protocol-src/pricing-engine/position-value";
// ── Certificate Lifecycle Manager (CLM) ────────────────────────────
import {
  refreshAndReadFees,
  autoClosePosition,
} from "../protocol-src/orchestrator/lifecycle";

// ── Chain config ────────────────────────────────────────────────────
import {
  MAINNET_USDC_MINT,
  SOL_MINT,
  MAINNET_WHIRLPOOL,
  deriveOrcaPositionPda,
  deriveTickArrayPda,
  tickArrayStartIndex,
} from "../protocol-src/config/chain";

// ── Birdeye ─────────────────────────────────────────────────────────
import {
  fetchOHLCV,
  computeVolatility,
} from "../protocol-src/market-data/birdeye-adapter";
import {
  fetchPoolOverview,
  estimatePositionDailyYield,
} from "../protocol-src/market-data/orca-volume-adapter";

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
const MONITOR_INTERVAL_S = 60;

/**
 * Tick offsets are derived from DEFAULT_TEMPLATE.widthBps so the on-chain
 * CL range exactly matches the emulator's linear hedge range [p_l, p_u]
 * with p_l = S_0 · (1 − widthBps/BPS), p_u = S_0 · (1 + widthBps/BPS).
 *
 * The offsets are asymmetric in tick space (log-price) because the price
 * range is arithmetically symmetric — e.g., widthBps=1000 gives tick
 * offsets of −1054 (down to 0.9·S_0) and +953 (up to 1.1·S_0).
 */
const LN_1_0001 = Math.log(1.0001);

function tickOffsetsFromWidthBps(widthBps: number): {
  below: number;
  above: number;
} {
  const below = Math.round(Math.log(10_000 / (10_000 - widthBps)) / LN_1_0001);
  const above = Math.round(Math.log((10_000 + widthBps) / 10_000) / LN_1_0001);
  return { below, above };
}

/** Close entirely to DUST-free to keep repeat runs from leaking capital. */
const POSITION_CLOSE_SLIPPAGE_BPS = 50; // 0.5% slippage tolerance on decrease

/**
 * Premium floor as a fraction of the actual position value V(S_0).
 * Default 1.5% — matches the range used in the §8 empirical analysis at
 * joint-breakeven. Override with env: P_FLOOR_FRACTION=0.02 etc.
 * Set to 0 to fall back to the absolute DEFAULT_PREMIUM_FLOOR_USDC.
 */
const P_FLOOR_FRACTION = parseFloat(
  process.env.P_FLOOR_FRACTION || "0.015",
);

/**
 * Override for DEFAULT_TEMPLATE.widthBps. Lets us A/B-test the same flow
 * at ±5% or ±15% without editing the template. Default = template default.
 */
const WIDTH_BPS_OVERRIDE = parseInt(
  process.env.WIDTH_BPS_OVERRIDE || String(DEFAULT_TEMPLATE.widthBps),
  10,
);

/**
 * Override for the pool's `markupFloor` governance parameter. Default
 * is `DEFAULT_POOL_CONFIG.markupFloor` (1.05). Setting below 1.0 means
 * the RT is willing to price below fair value when IV/RV indicates a
 * quiet regime — USE WITH CAUTION: RT's expected profit is no longer
 * guaranteed to be positive.
 */
const MARKUP_FLOOR_OVERRIDE = parseFloat(
  process.env.MARKUP_FLOOR || String(DEFAULT_POOL_CONFIG.markupFloor),
);

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
  // Whirlpool fee_rate is stored as parts per million (1_000_000 = 100%);
  // for the SOL/USDC 0.04% pool on-chain value is 400.
  const feeTierDecimal = wp.feeRate / 1_000_000;
  console.log(`  Fee rate:          ${(feeTierDecimal * 100).toFixed(3)}%  (on-chain u16 = ${wp.feeRate})`);

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

  // Measurement-driven expectedDailyFee: replaces the hardcoded
  // DEFAULT_EXPECTED_DAILY_FEE = 0.5%/day governance constant by
  //   r_position = (vol_24h × fee_tier / TVL) × inRangeFraction
  // where inRangeFraction adjusts for the template's width under GBM at σ.
  //
  // Fallback path (no API key or fetch failure) keeps the script runnable
  // on the governance default so local runs without Birdeye still work.
  let expectedDailyFee = DEFAULT_POOL_CONFIG.expectedDailyFee;
  let feeYieldSource = "governance default (0.5%/day)";
  if (birdeyeKey) {
    try {
      console.log("  Fetching Birdeye pool overview for fee-yield estimate...");
      const overview = await fetchPoolOverview(
        birdeyeKey,
        whirlpoolAddress.toBase58(),
        feeTierDecimal,
      );
      const est = estimatePositionDailyYield(
        overview,
        WIDTH_BPS_OVERRIDE,
        sigmaPpm / 1_000_000,
        DEFAULT_TEMPLATE.tenorSeconds,
      );
      expectedDailyFee = est.positionDailyYield;
      feeYieldSource =
        `Birdeye (TVL=$${(overview.liquidityUsd / 1e6).toFixed(2)}M, ` +
        `vol24h=$${(overview.volume24hUsd / 1e6).toFixed(2)}M, ` +
        `fee=${(overview.feeTier * 100).toFixed(3)}%, ` +
        `inRangeFrac=${est.inRangeFraction.toFixed(3)})`;
      console.log(
        `  r_pool:        ${(est.poolDailyYield * 100).toFixed(4)}%/day`,
      );
      console.log(
        `  inRangeFrac:   ${est.inRangeFraction.toFixed(4)}  (±${WIDTH_BPS_OVERRIDE / 100}%, σ=${(sigmaPpm / 10_000).toFixed(1)}%, T=${(DEFAULT_TEMPLATE.tenorSeconds / 86_400).toFixed(1)}d)`,
      );
      console.log(
        `  r_position:    ${(expectedDailyFee * 100).toFixed(4)}%/day  (measurement-driven)`,
      );
    } catch (e: any) {
      console.log(
        `  Pool-overview fetch failed: ${e.message}. Falling back to governance default.`,
      );
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: Open Orca position
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 2: OPEN ORCA POSITION");

  // Align the on-chain CL range to the emulator's linear [p_l, p_u]
  // corridor derived from DEFAULT_TEMPLATE.widthBps. Asymmetric tick
  // offsets because tick-space is log-price.
  const { below: tickOffsetBelow, above: tickOffsetAbove } =
    tickOffsetsFromWidthBps(WIDTH_BPS_OVERRIDE);
  const lowerTick = alignTick(
    wp.tickCurrentIndex - tickOffsetBelow,
    wp.tickSpacing,
    "down",
  );
  const upperTick = alignTick(
    wp.tickCurrentIndex + tickOffsetAbove,
    wp.tickSpacing,
    "up",
  );

  console.log(
    `  Tick range:  [${lowerTick}, ${upperTick}]  (±${WIDTH_BPS_OVERRIDE / 100}% linear, aligned to emulator corridor)`,
  );

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
  const { clPositionValue } = await import("../protocol-src/pricing-engine/position-value");
  const pL_usd = entryPrice * (1 - WIDTH_BPS_OVERRIDE / 10_000);
  const pU_usd = entryPrice * (1 + WIDTH_BPS_OVERRIDE / 10_000);
  const unitValue = clPositionValue(entryPrice, 1.0, pL_usd, pU_usd);
  const normalizedL = unitValue > 0 ? entryValueUsd / unitValue : 1;
  console.log(`  On-chain L:     ${posData.liquidity.toString()}`);
  console.log(`  Normalized L:   ${normalizedL.toFixed(2)} (for emulator CL math)`);

  // ─── Concentration-factor measurement ────────────────────────────
  // Re-read the whirlpool AFTER the position is open so L_active
  // reflects the state the position will actually earn fees against.
  // If the measurement is plausible (c in [0.5, 50]), recompute
  // expectedDailyFee with the measured c. Otherwise fall back to c=1
  // with a warning — the fallback is intentional and governance-visible.
  if (birdeyeKey) {
    try {
      const wpAfterInfo = await connection.getAccountInfo(whirlpoolAddress);
      if (wpAfterInfo) {
        const wpAfter = decodeWhirlpoolAccount(Buffer.from(wpAfterInfo.data));
        const { computeConcentrationFactor, fetchPoolOverview, estimatePositionDailyYield } =
          await import("../protocol-src/market-data/orca-volume-adapter");
        const overviewForC = await fetchPoolOverview(
          birdeyeKey,
          whirlpoolAddress.toBase58(),
          feeTierDecimal,
        );
        const c = computeConcentrationFactor({
          L_position: posData.liquidity,
          L_active: wpAfter.liquidity,
          V_position_usd: entryValueUsd,
          TVL_usd: overviewForC.liquidityUsd,
        });
        const shareL = Number(posData.liquidity) / Number(wpAfter.liquidity);
        const shareV = entryValueUsd / overviewForC.liquidityUsd;
        console.log(
          `  c-probe:        L_active=${wpAfter.liquidity} | L-share=${(shareL * 100).toExponential(3)} | V-share=${(shareV * 100).toExponential(3)}`,
        );
        const SANITY_MIN = 0.5, SANITY_MAX = 50;
        if (c === null || c < SANITY_MIN || c > SANITY_MAX) {
          console.log(
            `  c-probe:        c=${c === null ? "NULL" : c.toFixed(4)} outside sanity [${SANITY_MIN}, ${SANITY_MAX}] — FALLBACK to c=1`,
          );
          // Keep the Phase-1 c=1 estimate unchanged (fallback path).
        } else {
          const refined = estimatePositionDailyYield(
            overviewForC,
            WIDTH_BPS_OVERRIDE,
            sigmaPpm / 1_000_000,
            DEFAULT_TEMPLATE.tenorSeconds,
            c,
          );
          const oldFee = expectedDailyFee;
          expectedDailyFee = refined.positionDailyYield;
          feeYieldSource =
            `Birdeye × on-chain c=${c.toFixed(3)} (TVL=$${(overviewForC.liquidityUsd / 1e6).toFixed(2)}M, ` +
            `inRangeFrac=${refined.inRangeFraction.toFixed(3)})`;
          console.log(
            `  c-probe:        c=${c.toFixed(4)} ✓ plausible — expectedDailyFee updated ${(oldFee * 100).toFixed(4)}%/day → ${(expectedDailyFee * 100).toFixed(4)}%/day`,
          );
        }
      }
    } catch (e: any) {
      console.log(`  c-probe failed: ${e.message}. Keeping Phase-1 estimate (c=1).`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3: Initialize protocol + buy certificate
  // ═══════════════════════════════════════════════════════════════════

  console.log("PHASE 3: INITIALIZE PROTOCOL + BUY CERTIFICATE");

  const protocol = new OffchainLhProtocol();

  // Scale P_floor to a fraction of the actual position value so the
  // premium stays meaningful at small/large positions alike. This is a
  // per-run override of the pool config — the governance default in
  // DEFAULT_POOL_CONFIG.premiumFloorUsdc is NOT modified. Setting
  // P_FLOOR_FRACTION=0 falls back to the absolute governance default.
  const scaledPFloorUsdc =
    P_FLOOR_FRACTION > 0
      ? Math.max(1, Math.floor(entryValueE6 * P_FLOOR_FRACTION))
      : DEFAULT_POOL_CONFIG.premiumFloorUsdc;
  const scaledPFloorUsd = scaledPFloorUsdc / 1_000_000;

  // Init pool. expectedDailyFee was resolved in Phase 1 from the Birdeye
  // pool-volume adapter (measurement-driven) or falls back to the
  // governance default if Birdeye was unavailable.
  protocol.initPool("admin", {
    ...DEFAULT_POOL_CONFIG,
    uMaxBps: 8000, // 80% utilization for demo
    premiumFloorUsdc: scaledPFloorUsdc,
    expectedDailyFee,
    markupFloor: MARKUP_FLOOR_OVERRIDE,
  });
  console.log(
    `  Pool initialized (uMax=80%, P_floor=${(P_FLOOR_FRACTION * 100).toFixed(2)}% = $${scaledPFloorUsd.toFixed(6)}, expectedDailyFee=${(expectedDailyFee * 100).toFixed(4)}%/day, markupFloor=${MARKUP_FLOOR_OVERRIDE.toFixed(3)})`,
  );
  console.log(`    fee-yield source: ${feeYieldSource}`);

  // RT deposits
  protocol.depositUsdc(rtWallet.publicKey.toBase58(), RT_DEPOSIT_USDC);
  console.log(`  RT deposited ${formatUsdc(RT_DEPOSIT_USDC)} USDC`);

  // Create template for the demo tenor
  const demoTemplate = {
    ...DEFAULT_TEMPLATE,
    templateId: 10,
    tenorSeconds: TENOR_SECONDS,
    widthBps: WIDTH_BPS_OVERRIDE,
  };
  protocol.createTemplate("admin", demoTemplate);
  console.log(`  Template 10 created (tenor=${TENOR_SECONDS}s)`);

  // Live IV/RV measurement: ATM SOL IV from Binance options / realized σ.
  // Fallback = 1.0 so that when the feed is unavailable (network, no
  // matching expiry, illiquid strikes), the markupFloor governance
  // parameter binds rather than stale assumed data. The fallback being
  // below the floor makes the incident governance-visible.
  let ivRvRatio = 1.0;
  let ivSource = "fallback (1.00 — markupFloor will bind)";
  try {
    const { fetchSolAtmImpliedVol, computeIvRvRatio } = await import(
      "../protocol-src/market-data/binance-iv-adapter"
    );
    const iv = await fetchSolAtmImpliedVol(TENOR_SECONDS);
    if (iv) {
      const rv = sigmaPpm / 1_000_000;
      const r = computeIvRvRatio(iv.markIV, rv);
      ivRvRatio = r.ratio;
      ivSource =
        `Binance ${iv.symbol}: IV=${(iv.markIV * 100).toFixed(2)}% vs RV=${(rv * 100).toFixed(2)}%` +
        ` → IV/RV=${ivRvRatio.toFixed(3)}` +
        ` (expiry off by ${iv.expiryMismatchDays.toFixed(1)}d, |δ−0.5|=${iv.deltaDistance.toFixed(3)})`;
    }
  } catch (e: any) {
    ivSource = `fetch failed: ${e.message}. Fallback 1.0 → markupFloor binds.`;
  }

  // Update regime with real measurements
  protocol.updateRegimeSnapshot("risk-svc", {
    sigmaPpm,
    sigma7dPpm,
    stressFlag,
    carryBpsPerDay: 5,
    ivRvRatio,
  });
  console.log(`  Regime updated (σ=${(sigmaPpm / 10_000).toFixed(1)}%, IV/RV=${ivRvRatio.toFixed(3)})`);
  console.log(`    IV source: ${ivSource}`);

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

  // Real accrued fees — delegated to the CLM fee-refresher. The refresher
  // tries an off-chain fee-growth replication first (no tx, no latency);
  // falls back to an on-chain update_fees_and_rewards tx; and finally to 0.
  const refresh = await refreshAndReadFees({
    connection,
    payer: lpWallet,
    whirlpool: whirlpoolAddress,
    positionPda: orcaPositionPda,
    tickArrayLower,
    tickArrayUpper,
    tickLowerIndex: lowerTick,
    tickUpperIndex: upperTick,
    tickSpacing: wp.tickSpacing,
    settlementPriceE6,
  });
  const feesAccruedUsdc = refresh.feesAccruedUsdc;
  console.log(`  Fee source:   ${refresh.source}`);
  if (refresh.txSignature) {
    console.log(`  Refresh tx:   ${refresh.txSignature.slice(0, 20)}...`);
  }
  console.log(
    `  Accrued fees: ${refresh.feeOwedALamports} lamports (A) + ${refresh.feeOwedBMicroUsdc} μUSDC (B) = $${(feesAccruedUsdc / 1_000_000).toFixed(6)}`,
  );
  if (refresh.attempts.offchainError) {
    console.log(`  [warn] offchain path error: ${refresh.attempts.offchainError}`);
  }
  if (refresh.attempts.onchainError) {
    console.log(`  [warn] onchain path error:  ${refresh.attempts.onchainError}`);
  }

  // Settle in emulator with the REAL fee value
  const settleResult = protocol.settleCertificate(
    "settler",
    positionMintStr,
    settlementPriceE6,
    feesAccruedUsdc,
  );

  const payoutUsdc = settleResult.payoutUsdc;
  const rtFeeIncome = settleResult.rtFeeIncomeUsdc;
  const outcome =
    settleResult.state === CertificateStatus.Settled
      ? payoutUsdc > 0
        ? "SETTLED — RT PAID LP (downside)"
        : "SETTLED — LP PAID RT (upside surrendered)"
      : "EXPIRED (S_T = S_0 exactly)";

  console.log(`  Outcome:      ${outcome}`);
  console.log(`  Signed payout:${formatUsdc(payoutUsdc)} USDC  (+ = RT→LP, − = LP→RT)`);
  console.log(`  Fee split:    ${formatUsdc(rtFeeIncome)} USDC (RT income)`);
  console.log(`  Cert state:   ${settleResult.state}`);

  // Compute PnL breakdown
  const feesUsd = feesAccruedUsdc / 1_000_000;
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
  console.log(`    Payout outflow:  ${-payoutUsd >= 0 ? "+" : ""}$${(-payoutUsd).toFixed(6)}`);
  console.log(`    NET:             ${rtPnl >= 0 ? "+" : ""}$${rtPnl.toFixed(6)}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Theorem 2.2 (Value Neutrality) — automatic check
  // ═══════════════════════════════════════════════════════════════════
  //   LP_hedged + RT  =  Unhedged − φ · P
  // ═══════════════════════════════════════════════════════════════════

  console.log("THEOREM 2.2 CHECK (Value Neutrality):");
  const phi = protocolFeeBps / 10_000;
  const expectedLeakage = phi * premiumUsd;
  const observedLeakage = lpUnhedgedPnl - (lpHedgedPnl + rtPnl);
  const residual = observedLeakage - expectedLeakage;
  const tolerance = 1e-4; // $0.0001 absolute
  console.log(`  LP_hedged + RT     = ${(lpHedgedPnl + rtPnl).toFixed(9)}`);
  console.log(`  Unhedged − φ·P     = ${(lpUnhedgedPnl - expectedLeakage).toFixed(9)}`);
  console.log(`  Residual           = ${residual.toFixed(9)}  (tolerance $${tolerance})`);
  if (Math.abs(residual) > tolerance) {
    console.error(
      `  ✗ FAIL: Theorem 2.2 residual exceeds tolerance — value-neutrality identity violated.`,
    );
    process.exitCode = 2;
  } else {
    console.log("  ✓ PASS: LP_hedged + RT = Unhedged − φ·P holds.");
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Phase 6: Cleanup (emulator)
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
  // Phase 6.5: Close the Orca position on-chain (reclaim capital)
  // ═══════════════════════════════════════════════════════════════════

  console.log();
  console.log("PHASE 6.5: CLOSE ORCA POSITION ON-CHAIN");
  try {
    const close = await autoClosePosition({
      connection,
      lpWallet,
      whirlpoolAddress,
      positionPda: orcaPositionPda,
      positionMint,
      ownerPositionAta,
      wsolAta,
      lpUsdcAta,
      tickArrayLower,
      tickArrayUpper,
      sqrtPriceLower,
      sqrtPriceUpper,
      slippageBps: POSITION_CLOSE_SLIPPAGE_BPS,
    });
    if (close.skipped) {
      console.log("  Position already empty — skipping on-chain close.");
    } else {
      console.log(`  Position closed! Tx: ${close.txSignature!.slice(0, 20)}...`);
      console.log(
        `  LP post-close balance: ${formatSol(close.postCloseLpSolLamports!)} SOL | ${formatUsdc(close.postCloseLpUsdcMicro!)} USDC`,
      );
    }
  } catch (e: any) {
    console.log(
      `  Close-position failed: ${e.message}. Position NFT remains live on-chain — you can close it manually in Orca UI.`,
    );
    if (e.logs) {
      for (const line of e.logs.slice(0, 8)) console.log("    ", line);
    }
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
