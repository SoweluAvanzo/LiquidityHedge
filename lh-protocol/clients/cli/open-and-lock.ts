#!/usr/bin/env ts-node
/**
 * open-and-lock.ts
 *
 * Opens a real Orca Whirlpool concentrated liquidity position on SOL/USDC,
 * transfers the position NFT into the LH protocol escrow vault, and calls
 * register_locked_position with Orca + Pyth validation.
 *
 * Usage:
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   npx ts-node clients/cli/open-and-lock.ts [--sol <amount>] [--usdc <amount>] [--width <ticks>]
 *
 * Environment:
 *   WHIRLPOOL_ADDRESS   — Orca SOL/USDC pool (required)
 *   PYTH_SOL_USD_FEED   — Pyth price feed address
 *   ANCHOR_WALLET       — path to keypair JSON
 *   ANCHOR_PROVIDER_URL — RPC endpoint
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../../target/types/lh_core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";

import {
  LH_CORE_PROGRAM_ID,
  WHIRLPOOL_ADDRESS,
  PYTH_SOL_USD_FEED,
  SOL_MINT,
  PDA_SEEDS,
} from "./config";

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
} from "./whirlpool-ix";

import {
  getOrCreateAta,
  buildCreateAtaIx,
  buildWrapSolIxs,
  buildUnwrapSolIx,
  sendTxWithRetry,
  formatSol,
  formatUsdc,
} from "./utils";

// ─── CLI Args ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let solAmount = 0.01; // SOL to deposit (default: 0.01 SOL = ~$1.5)
  let usdcAmount = 2.0; // USDC to deposit (default: 2 USDC)
  let widthTicks = 200; // tick width on each side of current price

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sol" && args[i + 1]) solAmount = parseFloat(args[++i]);
    if (args[i] === "--usdc" && args[i + 1]) usdcAmount = parseFloat(args[++i]);
    if (args[i] === "--width" && args[i + 1])
      widthTicks = parseInt(args[++i], 10);
  }

  return { solAmount, usdcAmount, widthTicks };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const { solAmount, usdcAmount, widthTicks } = parseArgs();

  // Setup Anchor provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const payer = wallet.payer;

  console.log("=== LH Protocol: Open and Lock Orca Position ===");
  console.log(`  Wallet:     ${payer.publicKey.toBase58()}`);
  console.log(`  Whirlpool:  ${WHIRLPOOL_ADDRESS.toBase58()}`);
  console.log(`  Pyth Feed:  ${PYTH_SOL_USD_FEED.toBase58()}`);
  console.log(`  SOL amount: ${solAmount}`);
  console.log(`  USDC amount: ${usdcAmount}`);
  console.log(`  Tick width: ±${widthTicks}`);
  console.log();

  // ── Step 1: Fetch and decode Whirlpool state ────────────────────

  console.log("Step 1: Fetching Whirlpool state...");
  const whirlpoolInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!whirlpoolInfo) {
    throw new Error(
      `Whirlpool account not found: ${WHIRLPOOL_ADDRESS.toBase58()}`
    );
  }
  const wp = decodeWhirlpoolAccount(Buffer.from(whirlpoolInfo.data));
  const currentPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);

  console.log(`  Current tick:    ${wp.tickCurrentIndex}`);
  console.log(`  Tick spacing:    ${wp.tickSpacing}`);
  console.log(`  Current price:   $${currentPrice.toFixed(4)}`);
  console.log(`  Token A (SOL):   ${wp.tokenMintA.toBase58()}`);
  console.log(`  Token B (USDC):  ${wp.tokenMintB.toBase58()}`);

  // ── Step 2: Compute tick range ──────────────────────────────────

  const lowerTick = alignTick(
    wp.tickCurrentIndex - widthTicks,
    wp.tickSpacing,
    "down"
  );
  const upperTick = alignTick(
    wp.tickCurrentIndex + widthTicks,
    wp.tickSpacing,
    "up"
  );

  console.log(`\nStep 2: Tick range = [${lowerTick}, ${upperTick}]`);

  // ── Step 3: Derive all PDAs ─────────────────────────────────────

  const positionMintKp = Keypair.generate();
  const positionMint = positionMintKp.publicKey;
  const [orcaPositionPda, positionBump] =
    deriveOrcaPositionPda(positionMint);
  const ownerPositionAta = deriveAta(payer.publicKey, positionMint);

  // Tick arrays
  const lowerTickArrayStart = getTickArrayStartIndex(
    lowerTick,
    wp.tickSpacing
  );
  const upperTickArrayStart = getTickArrayStartIndex(
    upperTick,
    wp.tickSpacing
  );
  const [tickArrayLower] = deriveTickArrayPda(
    WHIRLPOOL_ADDRESS,
    lowerTickArrayStart
  );
  const [tickArrayUpper] = deriveTickArrayPda(
    WHIRLPOOL_ADDRESS,
    upperTickArrayStart
  );

  // LH Protocol PDAs
  const [poolState] = PublicKey.findProgramAddressSync(
    [PDA_SEEDS.pool],
    program.programId
  );
  const [lhPositionState] = PublicKey.findProgramAddressSync(
    [PDA_SEEDS.position, positionMint.toBuffer()],
    program.programId
  );

  console.log(`\nStep 3: PDAs derived`);
  console.log(`  Position mint:      ${positionMint.toBase58()}`);
  console.log(`  Orca position PDA:  ${orcaPositionPda.toBase58()}`);
  console.log(`  LH position state:  ${lhPositionState.toBase58()}`);
  console.log(`  Pool state:         ${poolState.toBase58()}`);

  // ── Step 4: Compute liquidity ───────────────────────────────────

  const solLamports = BigInt(Math.floor(solAmount * 1_000_000_000));
  const usdcMicro = BigInt(Math.floor(usdcAmount * 1_000_000));

  const sqrtPriceLower = tickToSqrtPriceX64(lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(upperTick);

  const liquidity = estimateLiquidity(
    solLamports,
    usdcMicro,
    wp.sqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper
  );

  // Add 5% slippage tolerance for max amounts
  const tokenMaxA = (solLamports * BigInt(105)) / BigInt(100);
  const tokenMaxB = (usdcMicro * BigInt(105)) / BigInt(100);

  console.log(`\nStep 4: Liquidity = ${liquidity.toString()}`);
  console.log(`  Max SOL:  ${formatSol(tokenMaxA)}`);
  console.log(`  Max USDC: ${formatUsdc(tokenMaxB)}`);

  // ── Step 5: Ensure token accounts exist ─────────────────────────

  console.log("\nStep 5: Ensuring token accounts...");

  // WSOL ATA for the wallet
  const wsolAta = await getOrCreateAta(
    connection,
    payer,
    SOL_MINT,
    payer.publicKey
  );
  console.log(`  WSOL ATA: ${wsolAta.toBase58()}`);

  // USDC ATA for the wallet (should already have USDC deposited)
  const usdcAta = await getOrCreateAta(
    connection,
    payer,
    wp.tokenMintB,
    payer.publicKey
  );
  console.log(`  USDC ATA: ${usdcAta.toBase58()}`);

  // Check USDC balance
  const usdcAccount = await getAccount(connection, usdcAta);
  console.log(
    `  USDC balance: ${formatUsdc(usdcAccount.amount)}`
  );
  if (usdcAccount.amount < usdcMicro) {
    throw new Error(
      `Insufficient USDC: have ${formatUsdc(usdcAccount.amount)}, need ${formatUsdc(usdcMicro)}`
    );
  }

  // ── Step 6: Transaction 1 — Open position + add liquidity ──────

  console.log("\nStep 6: Opening Orca position...");

  const openPositionIx = buildOpenPositionIx({
    funder: payer.publicKey,
    owner: payer.publicKey,
    positionPda: orcaPositionPda,
    positionBump,
    positionMint,
    positionTokenAccount: ownerPositionAta,
    whirlpool: WHIRLPOOL_ADDRESS,
    tickLowerIndex: lowerTick,
    tickUpperIndex: upperTick,
  });

  // Wrap SOL
  const wrapIxs = buildWrapSolIxs(
    payer.publicKey,
    wsolAta,
    Number(tokenMaxA)
  );

  const increaseLiqIx = buildIncreaseLiquidityIx({
    whirlpool: WHIRLPOOL_ADDRESS,
    positionAuthority: payer.publicKey,
    positionPda: orcaPositionPda,
    positionTokenAccount: ownerPositionAta,
    tokenOwnerAccountA: wsolAta,
    tokenOwnerAccountB: usdcAta,
    tokenVaultA: wp.tokenVaultA,
    tokenVaultB: wp.tokenVaultB,
    tickArrayLower,
    tickArrayUpper,
    liquidityAmount: liquidity,
    tokenMaxA,
    tokenMaxB,
  });

  // Unwrap remaining WSOL after deposit
  const unwrapIx = buildUnwrapSolIx(wsolAta, payer.publicKey);

  const tx1 = new Transaction();
  tx1.add(openPositionIx);
  tx1.add(...wrapIxs);
  tx1.add(increaseLiqIx);
  tx1.add(unwrapIx);

  const sig1 = await sendTxWithRetry(connection, tx1, [
    payer,
    positionMintKp,
  ]);
  console.log(`  Position opened! Tx: ${sig1}`);

  // Verify position NFT is in wallet
  const posAta = await getAccount(connection, ownerPositionAta);
  console.log(`  Position NFT balance: ${posAta.amount}`);

  // ── Step 7: Transaction 2 — Create escrow vault + transfer + register ──

  console.log("\nStep 7: Locking position in LH protocol escrow...");

  // Create escrow vault ATA (owned by pool_state PDA)
  const { ix: createVaultIx, ata: escrowVaultAta } = buildCreateAtaIx(
    payer.publicKey,
    positionMint,
    poolState,
    true // allowOwnerOffCurve = true for PDA owner
  );

  // Transfer position NFT from owner to escrow vault
  const transferNftIx = createTransferInstruction(
    ownerPositionAta,
    escrowVaultAta,
    payer.publicKey,
    1 // Transfer exactly 1 NFT
  );

  // Compute entry price from the Whirlpool's current price (in e6 format)
  const priceE6 = Math.floor(currentPrice * 1_000_000);

  // Register the locked position via LH program
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
      positionMint: positionMint,
      whirlpool: WHIRLPOOL_ADDRESS,
      orcaPosition: orcaPositionPda,
      vaultPositionAta: escrowVaultAta,
      positionState: lhPositionState,
      poolState: poolState,
      pythPriceFeed: PYTH_SOL_USD_FEED,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx2 = new Transaction();
  tx2.add(createVaultIx);
  tx2.add(transferNftIx);
  tx2.add(registerIx);

  const sig2 = await sendTxWithRetry(connection, tx2, [payer]);
  console.log(`  Position locked! Tx: ${sig2}`);

  // ── Step 8: Verify final state ──────────────────────────────────

  console.log("\nStep 8: Verifying...");

  const positionState = await program.account.positionState.fetch(
    lhPositionState
  );
  console.log(`  Status:       ${positionState.status} (1=LOCKED)`);
  console.log(`  Owner:        ${positionState.owner.toBase58()}`);
  console.log(`  Lower tick:   ${positionState.lowerTick}`);
  console.log(`  Upper tick:   ${positionState.upperTick}`);
  console.log(`  Entry price:  $${(positionState.p0PriceE6.toNumber() / 1_000_000).toFixed(4)}`);
  console.log(`  Oracle price: $${(positionState.oracleP0E6.toNumber() / 1_000_000).toFixed(4)}`);
  console.log(
    `  Protected by: ${positionState.protectedBy ? positionState.protectedBy.toBase58() : "none"}`
  );

  // Verify vault holds the NFT
  const vault = await getAccount(connection, escrowVaultAta);
  console.log(`  Vault NFT:    ${vault.amount} (should be 1)`);

  console.log("\n=== Position successfully opened and locked! ===");
  console.log(`  Position mint:  ${positionMint.toBase58()}`);
  console.log(`  Save this for certificate purchase.`);
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
