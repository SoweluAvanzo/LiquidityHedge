#!/usr/bin/env ts-node
/**
 * live-demo.ts — Full 20-minute live hedging demo with PnL comparison.
 *
 * Demonstrates the complete Liquidity Hedge Protocol with two wallets:
 *   - Risk Taker (RT): deposits USDC into pool, earns premium
 *   - Liquidity Provider (LP): opens Orca position, buys hedge certificate
 *
 * After the certificate expires (20 minutes), the script settles, compares
 * hedged vs unhedged PnL, and produces a full report.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://mainnet.helius-rpc.com/?api-key=... \
 *   WALLET_LP=~/.config/solana/id.json \
 *   WALLET_RT=./wallet-rt.json \
 *   WHIRLPOOL_ADDRESS=Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
 *   npx ts-node scripts/live-demo.ts
 *
 * Prerequisites:
 *   - Program deployed and initialized (pool + template + regime exist)
 *   - Both wallets funded with SOL (for tx fees) + USDC
 *   - Orca SOL/USDC Whirlpool exists with liquidity
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../target/types/lh_core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  PDA_SEEDS,
  WHIRLPOOL_ADDRESS,
  PYTH_SOL_USD_FEED,
  SOL_MINT,
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
  buildCreateMintIxs,
  sendTxWithRetry,
  formatSol,
  formatUsdc,
} from "../clients/cli/utils";
import {
  snapshotPosition,
  formatPositionSnapshot,
  PositionSnapshot,
} from "../clients/cli/position-value";
import {
  snapshotWallet,
  formatWalletSnapshot,
  compareWalletSnapshots,
  WalletSnapshot,
} from "../clients/cli/wallet-snapshot";

// ─── Config ──────────────────────────────────────────────────────────

const TENOR_SECONDS = 1200; // 20 minutes
const RT_DEPOSIT_USDC = 20_000_000; // 20 USDC
const LP_SOL = 0.01; // SOL for position
const LP_USDC = 2.0; // USDC for position
const CAP_USDC = 5_000_000; // 5 USDC max payout
const NOTIONAL_USDC = 10_000_000; // 10 USDC notional
const BARRIER_PCT = 0.95; // 5% below entry price
const MONITOR_INTERVAL_S = 60; // log every 60 seconds
const TICK_WIDTH = 200; // tick range width

// ─── PDA Helpers ─────────────────────────────────────────────────────

function findPool(pid: PublicKey) {
  return PublicKey.findProgramAddressSync([PDA_SEEDS.pool], pid);
}
function findVault(pid: PublicKey) {
  return PublicKey.findProgramAddressSync([PDA_SEEDS.poolVault], pid);
}
function findShareMint(pid: PublicKey) {
  return PublicKey.findProgramAddressSync([PDA_SEEDS.shareMint], pid);
}
function findTemplate(pid: PublicKey, id: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(id);
  return PublicKey.findProgramAddressSync([PDA_SEEDS.template, buf], pid);
}
function findRegime(pid: PublicKey, poolState: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [PDA_SEEDS.regime, poolState.toBuffer()],
    pid
  );
}
function findPosition(pid: PublicKey, positionMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [PDA_SEEDS.position, positionMint.toBuffer()],
    pid
  );
}
function findCertificate(pid: PublicKey, positionMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [PDA_SEEDS.certificate, positionMint.toBuffer()],
    pid
  );
}

function loadKeypair(path: string): Keypair {
  const resolved = path.replace("~", process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  // ── Setup ──────────────────────────────────────────────────────

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const connection = provider.connection;
  const pid = program.programId;

  const lpKeyPath = process.env.WALLET_LP || process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const rtKeyPath = process.env.WALLET_RT;
  if (!rtKeyPath) {
    console.error("ERROR: WALLET_RT env var required (path to RT keypair JSON)");
    console.error("Generate one: solana-keygen new -o wallet-rt.json");
    process.exit(1);
  }

  const lpWallet = loadKeypair(lpKeyPath);
  const rtWallet = loadKeypair(rtKeyPath);

  const [poolState] = findPool(pid);
  const [usdcVault] = findVault(pid);
  const [shareMint] = findShareMint(pid);
  const pool = await program.account.poolState.fetch(poolState);
  const usdcMint = pool.usdcMint;

  // Get current price from Whirlpool
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found");
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));
  const entryPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   LIQUIDITY HEDGE PROTOCOL — LIVE DEMO          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Program:     ${pid.toBase58()}`);
  console.log(`  LP Wallet:   ${lpWallet.publicKey.toBase58()}`);
  console.log(`  RT Wallet:   ${rtWallet.publicKey.toBase58()}`);
  console.log(`  SOL Price:   $${entryPrice.toFixed(2)}`);
  console.log(`  Tenor:       ${TENOR_SECONDS}s (${(TENOR_SECONDS / 60).toFixed(0)} minutes)`);
  console.log();

  // ── T+0:00 — Initial wallet snapshots ──────────────────────────

  console.log("T+0:00  INITIAL SNAPSHOTS");
  const w0_lp = await snapshotWallet(connection, lpWallet.publicKey, usdcMint, entryPrice);
  const w0_rt = await snapshotWallet(connection, rtWallet.publicKey, usdcMint, entryPrice);
  console.log(formatWalletSnapshot(w0_lp, "LP Wallet (before)"));
  console.log(formatWalletSnapshot(w0_rt, "RT Wallet (before)"));
  console.log();

  // ── T+0:01 — RT deposits USDC into pool ───────────────────────

  console.log("T+0:01  RT DEPOSITS USDC INTO POOL");
  const rtUsdc = await getOrCreateAta(connection, rtWallet, usdcMint, rtWallet.publicKey);
  const rtShares = await getOrCreateAta(connection, rtWallet, shareMint, rtWallet.publicKey);

  await program.methods
    .depositUsdc(new anchor.BN(RT_DEPOSIT_USDC))
    .accountsPartial({
      depositor: rtWallet.publicKey,
      poolState,
      usdcVault,
      depositorUsdc: rtUsdc,
      shareMint,
      depositorShares: rtShares,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([rtWallet])
    .rpc();

  console.log(`  RT deposited ${formatUsdc(RT_DEPOSIT_USDC)} USDC`);
  console.log();

  // ── T+0:02 — LP opens Orca position + locks + buys certificate ─

  console.log("T+0:02  LP OPENS POSITION + LOCKS + BUYS CERTIFICATE");

  // Compute tick range
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

  // Ensure WSOL + USDC ATAs
  const wsolAta = await getOrCreateAta(connection, lpWallet, SOL_MINT, lpWallet.publicKey);
  const lpUsdcAta = await getOrCreateAta(connection, lpWallet, wp.tokenMintB, lpWallet.publicKey);

  // Tx1: Open position
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

  // Tx2: Lock position in escrow
  const { ix: createVaultIx, ata: escrowVaultAta } = buildCreateAtaIx(
    lpWallet.publicKey, positionMint, poolState, true
  );
  const transferNftIx = createTransferInstruction(
    ownerPositionAta, escrowVaultAta, lpWallet.publicKey, 1
  );
  const priceE6 = Math.floor(entryPrice * 1_000_000);
  const [lhPositionState] = findPosition(pid, positionMint);

  const registerIx = await program.methods
    .registerLockedPosition(
      new anchor.BN(priceE6), new anchor.BN(solLamports.toString()),
      new anchor.BN(usdcMicro.toString()), lowerTick, upperTick
    )
    .accountsPartial({
      owner: lpWallet.publicKey, positionMint, whirlpool: WHIRLPOOL_ADDRESS,
      orcaPosition: orcaPositionPda, vaultPositionAta: escrowVaultAta,
      positionState: lhPositionState, poolState,
      pythPriceFeed: PYTH_SOL_USD_FEED, systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx2 = new Transaction().add(createVaultIx, transferNftIx, registerIx);
  await sendTxWithRetry(connection, tx2, [lpWallet]);
  console.log(`  Position locked in escrow`);

  // Tx3: Buy certificate
  const barrierE6 = Math.floor(entryPrice * BARRIER_PCT * 1_000_000);
  const { mintKeypair: certMintKp, instructions: certMintIxs } =
    await buildCreateMintIxs(connection, lpWallet.publicKey, poolState, 0);
  const buyerCertAta = getAssociatedTokenAddressSync(certMintKp.publicKey, lpWallet.publicKey);
  const createCertAtaIx = createAssociatedTokenAccountInstruction(
    lpWallet.publicKey, buyerCertAta, lpWallet.publicKey, certMintKp.publicKey
  );
  const tx3a = new Transaction().add(...certMintIxs, createCertAtaIx);
  await sendTxWithRetry(connection, tx3a, [lpWallet, certMintKp]);

  // Find the 20-minute template (template_id=2)
  const [template2Pda] = findTemplate(pid, 2);
  const [regimePda] = findRegime(pid, poolState);
  const [certPda] = findCertificate(pid, positionMint);
  const lpBuyerUsdc = await getOrCreateAta(connection, lpWallet, usdcMint, lpWallet.publicKey);

  await program.methods
    .buyCertificate(new anchor.BN(CAP_USDC), new anchor.BN(barrierE6), new anchor.BN(NOTIONAL_USDC))
    .accountsPartial({
      buyer: lpWallet.publicKey, positionState: lhPositionState, poolState, usdcVault,
      buyerUsdc: lpBuyerUsdc, template: template2Pda, regimeSnapshot: regimePda,
      certificateState: certPda, certMint: certMintKp.publicKey, buyerCertAta,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([lpWallet])
    .rpc();

  const cert = await program.account.certificateState.fetch(certPda);
  const premiumPaid = cert.premiumUsdc.toNumber();
  const expiryTs = cert.expiryTs.toNumber();

  console.log(`  Certificate purchased!`);
  console.log(`    Premium:  ${formatUsdc(premiumPaid)} USDC`);
  console.log(`    Cap:      ${formatUsdc(CAP_USDC)} USDC`);
  console.log(`    Barrier:  $${(barrierE6 / 1e6).toFixed(4)}`);
  console.log(`    Expiry:   ${new Date(expiryTs * 1000).toISOString()}`);

  // Entry position snapshot
  const pv0 = await snapshotPosition(
    connection, positionMint, WHIRLPOOL_ADDRESS, solLamports, usdcMicro
  );
  console.log();
  console.log(formatPositionSnapshot(pv0, "Position at Entry"));
  console.log();

  // ── T+0:02..T+0:20 — Monitor ──────────────────────────────────

  console.log("MONITORING (every 60s until expiry)...");
  const now = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, expiryTs - now);

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

  // ── T+0:20 — Settlement ────────────────────────────────────────

  console.log();
  console.log("T+0:20  SETTLEMENT");

  // Wait a bit extra to ensure expiry has passed
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

  // Settle
  const ownerUsdcForPayout = await getOrCreateAta(
    connection, lpWallet, usdcMint, lpWallet.publicKey
  );

  await program.methods
    .settleCertificate()
    .accountsPartial({
      settler: lpWallet.publicKey, certificateState: certPda,
      positionState: lhPositionState, poolState, usdcVault,
      ownerUsdc: ownerUsdcForPayout, pythPriceFeed: PYTH_SOL_USD_FEED,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([lpWallet])
    .rpc();

  const certAfter = await program.account.certificateState.fetch(certPda);
  console.log(`  Certificate state: ${certAfter.state} (2=SETTLED, 3=EXPIRED)`);

  // ── T+0:21 — Cleanup ──────────────────────────────────────────

  console.log();
  console.log("T+0:21  CLEANUP");

  // Release position
  const ownerPosAta = await getOrCreateAta(
    connection, lpWallet, positionMint, lpWallet.publicKey
  );
  await program.methods
    .releasePosition()
    .accountsPartial({
      owner: lpWallet.publicKey, positionState: lhPositionState, poolState,
      vaultPositionAta: escrowVaultAta, ownerPositionAta: ownerPosAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([lpWallet])
    .rpc();
  console.log("  Position released to LP");

  // RT withdraws
  const rtShareBal = await getAccount(connection, rtShares);
  if (rtShareBal.amount > BigInt(0)) {
    await program.methods
      .withdrawUsdc(new anchor.BN(rtShareBal.amount.toString()))
      .accountsPartial({
        withdrawer: rtWallet.publicKey, poolState, usdcVault,
        withdrawerUsdc: rtUsdc, shareMint, withdrawerShares: rtShares,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([rtWallet])
      .rpc();
    console.log("  RT withdrew from pool");
  }

  // ── T+0:22 — Final snapshots + Report ──────────────────────────

  console.log();
  console.log("T+0:22  FINAL REPORT");

  const settlementPrice = pv1.price;
  const w2_lp = await snapshotWallet(connection, lpWallet.publicKey, usdcMint, settlementPrice);
  const w2_rt = await snapshotWallet(connection, rtWallet.publicKey, usdcMint, settlementPrice);

  // Compute payout (check if certificate was settled with payout)
  const payout = certAfter.state === 2 // SETTLED means payout > 0
    ? w2_lp.totalValueUsd - w0_lp.totalValueUsd + premiumPaid / 1e6
    : 0;

  const positionPnl = pv1.valueUsd - pv0.valueUsd;
  const hedgedNetPnl = positionPnl + (payout > 0 ? payout : 0) - premiumPaid / 1e6;
  const unhedgedPnl = positionPnl;
  const hedgeBenefit = hedgedNetPnl - unhedgedPnl;

  console.log();
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         HEDGING EFFECTIVENESS REPORT             ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`SOL Price:  Entry=$${entryPrice.toFixed(2)}  Settlement=$${settlementPrice.toFixed(2)}  Change=${(((settlementPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%`);
  console.log();
  console.log(`── Orca Position ──`);
  console.log(`  Entry value:      $${pv0.valueUsd.toFixed(4)}`);
  console.log(`  Settlement value: $${pv1.valueUsd.toFixed(4)}`);
  console.log(`  Position PnL:     ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(4)} (${((positionPnl / pv0.valueUsd) * 100).toFixed(2)}%)`);
  console.log(`  Hold value:       $${pv1.holdValueUsd.toFixed(4)}`);
  console.log(`  IL:               $${pv1.ilUsd.toFixed(4)} (${pv1.ilPct.toFixed(2)}%)`);
  console.log();
  console.log(`── Hedge Certificate ──`);
  console.log(`  Premium paid:     $${(premiumPaid / 1e6).toFixed(6)}`);
  console.log(`  Cap:              $${(CAP_USDC / 1e6).toFixed(2)}`);
  console.log(`  Barrier:          $${(barrierE6 / 1e6).toFixed(4)}`);
  console.log(`  Settlement price: $${settlementPrice.toFixed(4)}`);
  console.log(`  Outcome:          ${certAfter.state === 2 ? "PAYOUT TRIGGERED" : "EXPIRED (no payout)"}`);
  console.log();
  console.log(`── LP Net PnL (Hedged) ──`);
  console.log(`  Position PnL:     ${positionPnl >= 0 ? "+" : ""}$${positionPnl.toFixed(4)}`);
  console.log(`  Premium cost:     -$${(premiumPaid / 1e6).toFixed(6)}`);
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
  console.log("═══════════════════════════════════════════════════");
  console.log("  Demo complete.");
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
