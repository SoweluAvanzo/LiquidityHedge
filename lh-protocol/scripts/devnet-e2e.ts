#!/usr/bin/env ts-node
/**
 * devnet-e2e.ts — Full end-to-end lifecycle of the Liquidity Hedge Protocol.
 *
 * Demonstrates:
 *   1. Pool initialization (skip if exists)
 *   2. Template + regime creation
 *   3. Risk taker deposits USDC
 *   4. LP opens Orca position + locks it
 *   5. LP buys a hedge certificate
 *   6. Settlement (after expiry)
 *   7. Position release
 *
 * Usage:
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   WHIRLPOOL_ADDRESS=<address> \
 *   npx ts-node scripts/devnet-e2e.ts
 *
 * Note: Steps 1-5 run immediately. Step 6 (settlement) requires waiting
 * for the certificate to expire (1 day for template 2). Run with --settle
 * to execute only the settlement + release steps.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../target/types/lh_core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { PDA_SEEDS, WHIRLPOOL_ADDRESS, PYTH_SOL_USD_FEED, SOL_MINT } from "../clients/cli/config";
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

// ─── PDA Helpers ─────────────────────────────────────────────────────

function findPool(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([PDA_SEEDS.pool], programId);
}
function findVault(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([PDA_SEEDS.poolVault], programId);
}
function findShareMint(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([PDA_SEEDS.shareMint], programId);
}
function findTemplate(programId: PublicKey, id: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(id);
  return PublicKey.findProgramAddressSync([PDA_SEEDS.template, buf], programId);
}
function findRegime(programId: PublicKey, poolState: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [PDA_SEEDS.regime, poolState.toBuffer()],
    programId
  );
}
function findPosition(programId: PublicKey, positionMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [PDA_SEEDS.position, positionMint.toBuffer()],
    programId
  );
}
function findCertificate(programId: PublicKey, positionMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [PDA_SEEDS.certificate, positionMint.toBuffer()],
    programId
  );
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const settleOnly = process.argv.includes("--settle");
  const positionMintArg = process.argv.find((a) => a.startsWith("--position-mint="));

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const payer = wallet.payer;
  const pid = program.programId;

  const [poolState] = findPool(pid);
  const [usdcVault] = findVault(pid);
  const [shareMint] = findShareMint(pid);

  console.log("=== LH Protocol End-to-End Demo ===");
  console.log(`  Program:  ${pid.toBase58()}`);
  console.log(`  Wallet:   ${payer.publicKey.toBase58()}`);
  console.log(`  Cluster:  ${connection.rpcEndpoint}`);
  console.log();

  // ── If --settle, jump to settlement ─────────────────────────────

  if (settleOnly) {
    if (!positionMintArg) {
      console.error("Usage: --settle --position-mint=<pubkey>");
      process.exit(1);
    }
    const positionMint = new PublicKey(positionMintArg.split("=")[1]);
    await settleAndRelease(program, connection, payer, poolState, positionMint);
    return;
  }

  // ── Step 1: Initialize pool ─────────────────────────────────────

  console.log("Step 1: Initializing pool...");
  const poolInfo = await connection.getAccountInfo(poolState);
  const usdcMint = await getPoolUsdcMint(program, poolState, poolInfo);

  if (!poolInfo) {
    await program.methods
      .initializePool(8000)
      .accountsPartial({
        admin: payer.publicKey,
        usdcMint,
        poolState,
        usdcVault,
        shareMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("  Pool initialized (U_max=80%)");
  } else {
    console.log("  Pool already exists, skipping");
  }

  // ── Step 2: Create short-tenor template + regime ────────────────

  console.log("\nStep 2: Creating template + regime...");

  // Template 2: 1-day tenor for fast E2E testing
  const [template2Pda] = findTemplate(pid, 2);
  try {
    await program.methods
      .createTemplate(
        2, // template_id
        new anchor.BN(1200), // 20 minutes (1200 seconds)
        1000, // 10% width
        new anchor.BN(500_000), // 50% severity
        new anchor.BN(1_000), // floor: 0.001 USDC
        new anchor.BN(1_000_000_000) // ceiling: 1000 USDC
      )
      .accountsPartial({
        admin: payer.publicKey,
        poolState,
        template: template2Pda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  Template 2 created (20-minute tenor = 1200s)");
  } catch (e: any) {
    if (e.toString().includes("already in use")) {
      console.log("  Template 2 already exists");
    } else throw e;
  }

  const [regimePda] = findRegime(pid, poolState);
  await program.methods
    .updateRegimeSnapshot(
      new anchor.BN(200_000), // sigma: 20%
      new anchor.BN(180_000), // sigma_ma: 18%
      false, // no stress
      10 // carry: 10 bps/day
    )
    .accountsPartial({
      authority: payer.publicKey,
      poolState,
      regimeSnapshot: regimePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  Regime snapshot updated (sigma=20%)");

  // ── Step 3: RT deposits USDC ────────────────────────────────────

  console.log("\nStep 3: Depositing USDC into pool...");
  const depositAmount = 20_000_000; // 20 USDC

  const depositorUsdc = await getOrCreateAta(
    connection,
    payer,
    usdcMint,
    payer.publicKey
  );
  const depositorShares = await getOrCreateAta(
    connection,
    payer,
    shareMint,
    payer.publicKey
  );

  // Check USDC balance
  const usdcBal = await getAccount(connection, depositorUsdc);
  if (usdcBal.amount < BigInt(depositAmount)) {
    console.log(
      `  WARNING: Insufficient USDC (have ${formatUsdc(usdcBal.amount)}, need ${formatUsdc(depositAmount)})`
    );
    console.log("  Please fund your USDC ATA and re-run.");
    console.log(`  USDC ATA: ${depositorUsdc.toBase58()}`);
    console.log(`  USDC Mint: ${usdcMint.toBase58()}`);
    process.exit(1);
  }

  await program.methods
    .depositUsdc(new anchor.BN(depositAmount))
    .accountsPartial({
      depositor: payer.publicKey,
      poolState,
      usdcVault,
      depositorUsdc,
      shareMint,
      depositorShares,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`  Deposited ${formatUsdc(depositAmount)} USDC`);

  const poolAfterDeposit = await program.account.poolState.fetch(poolState);
  console.log(`  Pool reserves: ${formatUsdc(poolAfterDeposit.reservesUsdc.toNumber())} USDC`);

  // ── Step 4: LP opens Orca position + locks it ───────────────────

  console.log("\nStep 4: Opening Orca position...");

  const whirlpoolInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!whirlpoolInfo) {
    throw new Error(`Whirlpool not found: ${WHIRLPOOL_ADDRESS.toBase58()}`);
  }
  const wp = decodeWhirlpoolAccount(Buffer.from(whirlpoolInfo.data));
  const currentPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);
  console.log(`  Current SOL price: $${currentPrice.toFixed(4)}`);

  const widthTicks = 200;
  const lowerTick = alignTick(wp.tickCurrentIndex - widthTicks, wp.tickSpacing, "down");
  const upperTick = alignTick(wp.tickCurrentIndex + widthTicks, wp.tickSpacing, "up");

  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] = deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(payer.publicKey, positionMint);

  const lowerTickArrayStart = getTickArrayStartIndex(lowerTick, wp.tickSpacing);
  const upperTickArrayStart = getTickArrayStartIndex(upperTick, wp.tickSpacing);
  const [tickArrayLower] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, lowerTickArrayStart);
  const [tickArrayUpper] = deriveTickArrayPda(WHIRLPOOL_ADDRESS, upperTickArrayStart);

  const solLamports = BigInt(10_000_000); // 0.01 SOL
  const usdcMicro = BigInt(2_000_000); // 2 USDC

  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);
  const liquidity = estimateLiquidity(solLamports, usdcMicro, wp.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const tokenMaxA = (solLamports * BigInt(110)) / BigInt(100);
  const tokenMaxB = (usdcMicro * BigInt(110)) / BigInt(100);

  // Ensure WSOL ATA
  const wsolAta = await getOrCreateAta(connection, payer, SOL_MINT, payer.publicKey);
  const usdcAtaLP = await getOrCreateAta(connection, payer, wp.tokenMintB, payer.publicKey);

  // Tx1: Open position + add liquidity
  const tx1 = new Transaction();
  tx1.add(
    buildOpenPositionIx({
      funder: payer.publicKey,
      owner: payer.publicKey,
      positionPda: orcaPositionPda,
      positionBump,
      positionMint,
      positionTokenAccount: ownerPositionAta,
      whirlpool: WHIRLPOOL_ADDRESS,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
    })
  );
  tx1.add(...buildWrapSolIxs(payer.publicKey, wsolAta, Number(tokenMaxA)));
  tx1.add(
    buildIncreaseLiquidityIx({
      whirlpool: WHIRLPOOL_ADDRESS,
      positionAuthority: payer.publicKey,
      positionPda: orcaPositionPda,
      positionTokenAccount: ownerPositionAta,
      tokenOwnerAccountA: wsolAta,
      tokenOwnerAccountB: usdcAtaLP,
      tokenVaultA: wp.tokenVaultA,
      tokenVaultB: wp.tokenVaultB,
      tickArrayLower,
      tickArrayUpper,
      liquidityAmount: liquidity,
      tokenMaxA,
      tokenMaxB,
    })
  );
  tx1.add(buildUnwrapSolIx(wsolAta, payer.publicKey));

  const sig1 = await sendTxWithRetry(connection, tx1, [payer, positionMintKp]);
  console.log(`  Orca position opened: ${sig1}`);

  // Tx2: Escrow + register
  const { ix: createVaultIx, ata: escrowVaultAta } = buildCreateAtaIx(
    payer.publicKey, positionMint, poolState, true
  );
  const transferNftIx = new Transaction().add(
    (await import("@solana/spl-token")).createTransferInstruction(
      ownerPositionAta, escrowVaultAta, payer.publicKey, 1
    )
  ).instructions[0];

  const priceE6 = Math.floor(currentPrice * 1_000_000);
  const [lhPositionState] = findPosition(pid, positionMint);

  const registerIx = await program.methods
    .registerLockedPosition(
      new anchor.BN(priceE6),
      new anchor.BN(solLamports.toString()),
      new anchor.BN(usdcMicro.toString()),
      lowerTick,
      upperTick,
      new anchor.BN(liquidity.toString())
    )
    .accountsPartial({
      owner: payer.publicKey,
      positionMint,
      whirlpool: WHIRLPOOL_ADDRESS,
      orcaPosition: orcaPositionPda,
      vaultPositionAta: escrowVaultAta,
      positionState: lhPositionState,
      poolState,
      pythPriceFeed: PYTH_SOL_USD_FEED,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx2 = new Transaction().add(createVaultIx, transferNftIx, registerIx);
  const sig2 = await sendTxWithRetry(connection, tx2, [payer]);
  console.log(`  Position locked: ${sig2}`);

  // ── Step 5: Buy certificate ─────────────────────────────────────

  console.log("\nStep 5: Buying hedge certificate...");

  const capUsdc = 5_000_000; // 5 USDC cap
  const barrierE6 = Math.floor(currentPrice * 0.95 * 1_000_000); // 5% below current
  const notionalUsdc = 10_000_000; // 10 USDC notional

  // Create cert mint (decimals=0, authority=poolState)
  const { mintKeypair: certMintKp, instructions: certMintIxs } =
    await buildCreateMintIxs(connection, payer.publicKey, poolState, 0);
  const certMint = certMintKp.publicKey;

  // Create buyer's cert ATA
  const buyerCertAta = getAssociatedTokenAddressSync(
    certMint, payer.publicKey, false
  );
  const createCertAtaIx = createAssociatedTokenAccountInstruction(
    payer.publicKey, buyerCertAta, payer.publicKey, certMint
  );

  // Create cert mint + ATA in one tx
  const txCert1 = new Transaction().add(...certMintIxs, createCertAtaIx);
  await sendTxWithRetry(connection, txCert1, [payer, certMintKp]);

  // Ensure buyer has enough USDC for premium
  const buyerUsdc = await getOrCreateAta(connection, payer, usdcMint, payer.publicKey);

  const [certPda] = findCertificate(pid, positionMint);
  const [regimePda2] = findRegime(pid, poolState);

  await program.methods
    .buyCertificate(
      new anchor.BN(capUsdc),
      new anchor.BN(barrierE6),
      new anchor.BN(notionalUsdc)
    )
    .accountsPartial({
      buyer: payer.publicKey,
      positionState: lhPositionState,
      poolState,
      usdcVault,
      buyerUsdc,
      template: template2Pda,
      regimeSnapshot: regimePda2,
      certificateState: certPda,
      certMint,
      buyerCertAta,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const cert = await program.account.certificateState.fetch(certPda);
  const poolAfterCert = await program.account.poolState.fetch(poolState);

  console.log(`  Certificate purchased!`);
  console.log(`  Premium:       ${formatUsdc(cert.premiumUsdc.toNumber())} USDC`);
  console.log(`  Cap:           ${formatUsdc(cert.capUsdc.toNumber())} USDC`);
  console.log(`  Barrier:       $${(cert.lowerBarrierE6.toNumber() / 1_000_000).toFixed(4)}`);
  console.log(`  Expiry:        ${new Date(cert.expiryTs.toNumber() * 1000).toISOString()}`);
  console.log(`  Pool reserves: ${formatUsdc(poolAfterCert.reservesUsdc.toNumber())} USDC`);
  console.log(`  Active cap:    ${formatUsdc(poolAfterCert.activeCapUsdc.toNumber())} USDC`);

  console.log("\n=== Steps 1-5 complete ===");
  console.log(`\nTo settle after expiry, run:`);
  console.log(
    `  npx ts-node scripts/devnet-e2e.ts --settle --position-mint=${positionMint.toBase58()}`
  );
}

// ─── Settlement + Release ────────────────────────────────────────────

async function settleAndRelease(
  program: Program<LhCore>,
  connection: anchor.web3.Connection,
  payer: Keypair,
  poolState: PublicKey,
  positionMint: PublicKey
) {
  const pid = program.programId;
  const [lhPositionState] = findPosition(pid, positionMint);
  const [certPda] = findCertificate(pid, positionMint);
  const [usdcVault] = findVault(pid);

  // Fetch current state
  const cert = await program.account.certificateState.fetch(certPda);
  const pool = await program.account.poolState.fetch(poolState);

  console.log("Step 6: Settling certificate...");
  console.log(`  Certificate state: ${cert.state} (1=ACTIVE)`);
  console.log(`  Expiry: ${new Date(cert.expiryTs.toNumber() * 1000).toISOString()}`);

  if (cert.state !== 1) {
    console.log("  Certificate is not active, skipping settlement");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < cert.expiryTs.toNumber()) {
    const remaining = cert.expiryTs.toNumber() - now;
    console.log(`  Certificate not yet expired (${remaining}s remaining)`);
    console.log("  Try again after expiry.");
    return;
  }

  // Owner USDC ATA for payout
  const ownerUsdc = await getOrCreateAta(
    connection,
    payer,
    pool.usdcMint,
    cert.owner
  );

  await program.methods
    .settleCertificate()
    .accountsPartial({
      settler: payer.publicKey,
      certificateState: certPda,
      positionState: lhPositionState,
      poolState,
      usdcVault,
      ownerUsdc,
      pythPriceFeed: PYTH_SOL_USD_FEED,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const certAfter = await program.account.certificateState.fetch(certPda);
  console.log(`  Settlement complete! State: ${certAfter.state} (2=SETTLED, 3=EXPIRED)`);

  // Step 7: Release position
  console.log("\nStep 7: Releasing position...");
  const posState = await program.account.positionState.fetch(lhPositionState);

  if (posState.protectedBy !== null) {
    console.log("  Position still protected, cannot release yet");
    return;
  }

  const escrowVaultAta = getAssociatedTokenAddressSync(
    positionMint, poolState, true // allowOwnerOffCurve for PDA
  );
  const ownerPositionAta = getAssociatedTokenAddressSync(
    positionMint, payer.publicKey, false
  );

  // Ensure owner ATA exists
  await getOrCreateAta(connection, payer, positionMint, payer.publicKey);

  await program.methods
    .releasePosition()
    .accountsPartial({
      owner: payer.publicKey,
      positionState: lhPositionState,
      poolState,
      vaultPositionAta: escrowVaultAta,
      ownerPositionAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("  Position released! NFT returned to wallet.");
  console.log("\n=== E2E lifecycle complete! ===");
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function getPoolUsdcMint(
  program: Program<LhCore>,
  poolState: PublicKey,
  poolInfo: any
): Promise<PublicKey> {
  if (poolInfo) {
    const pool = await program.account.poolState.fetch(poolState);
    return pool.usdcMint;
  }
  // Default to devnet USDC
  const cluster = process.env.SOLANA_CLUSTER || "devnet";
  return cluster === "mainnet-beta"
    ? new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    : new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
