#!/usr/bin/env ts-node
/**
 * Devnet end-to-end rehearsal (plan Phase 4 item 5, first half).
 *
 * Exercises the REAL money path against a live cluster with a throwaway
 * 6-decimal test mint standing in for USDC:
 *
 *   quote → buyer pays EXACT amount + memo reference on-chain →
 *   scanTreasuryPayments (finalized) → ledger observePayment → activation →
 *   expiry → settle → buildPayoutInstructions → on-chain payout →
 *   buyer balance verified.
 *
 * The position and settlement price are synthetic (the oracle policy is a
 * separate port); everything monetary is real devnet transactions.
 *
 * Usage: pnpm --filter @lh/ops-jobs devnet-rehearsal
 * Keypairs are ephemeral (funded by airdrop) and saved to the scratch dir
 * given by REHEARSAL_DIR (default: os.tmpdir()) for reuse across runs.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  CertificateLedger,
  LedgerConfig,
  HedgedPositionInput,
  scanTreasuryPayments,
  buildPayoutInstructions,
  runSettlementCycle,
  RunnerPorts,
  sha256Hex,
  MEMO_PROGRAM_ID,
} from "@lh/hedge";

const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const TENOR_S = 60;

function loadOrCreateKeypair(file: string): Keypair {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  return kp;
}

async function ensureSol(conn: Connection, pubkey: PublicKey, minSol: number): Promise<void> {
  const bal = await conn.getBalance(pubkey);
  if (bal >= minSol * LAMPORTS_PER_SOL) return;
  // Devnet faucet is flaky/rate-limited: retry with backoff, small amounts.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`  airdrop attempt ${attempt}/5: ${minSol} SOL to ${pubkey.toBase58().slice(0, 8)}…`);
      const sig = await conn.requestAirdrop(pubkey, minSol * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "finalized");
      // Belt and braces: poll until the balance is visible at finalized.
      for (let i = 0; i < 30; i++) {
        const bal = await conn.getBalance(pubkey, "finalized");
        if (bal >= minSol * LAMPORTS_PER_SOL) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      return;
    } catch (e: any) {
      console.log(`    faucet refused (${(e.message ?? e).toString().slice(0, 60)})`);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 12_000 * attempt));
    }
  }
  throw new Error(
    `devnet faucet exhausted for ${pubkey.toBase58()} — fund it manually ` +
      `(https://faucet.solana.com) and re-run; keypairs persist in REHEARSAL_DIR`,
  );
}

async function main() {
  const dir = process.env.REHEARSAL_DIR ?? path.resolve(__dirname, "../../../../lh-protocol-archive/devnet-rehearsal");
  fs.mkdirSync(dir, { recursive: true });
  const conn = new Connection(RPC, "confirmed");

  console.log("1. Keypairs + airdrops (devnet)");
  const treasury = loadOrCreateKeypair(path.join(dir, "treasury.json"));
  const buyer = loadOrCreateKeypair(path.join(dir, "buyer.json"));
  await ensureSol(conn, treasury.publicKey, 2);
  if ((await conn.getBalance(buyer.publicKey)) < 0.1 * LAMPORTS_PER_SOL) {
    const { SystemProgram } = await import("@solana/web3.js");
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey: buyer.publicKey,
          lamports: 0.3 * LAMPORTS_PER_SOL,
        }),
      ),
      [treasury],
      { commitment: "finalized" },
    );
    console.log("  buyer funded from treasury (0.3 SOL)");
  }

  console.log("2. Test mint (6 decimals) + ATAs + initial balances");
  const mintFile = path.join(dir, "mint.json");
  const mintKp = loadOrCreateKeypair(mintFile);
  const mint = mintKp.publicKey;
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo) {
    const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    const tx = new Transaction().add(
      // create + init mint, treasury is mint authority
      new TransactionInstruction({
        programId: new PublicKey("11111111111111111111111111111111"),
        keys: [
          { pubkey: treasury.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint, isSigner: true, isWritable: true },
        ],
        data: (() => {
          // SystemProgram.createAccount manual encode avoided — use helper:
          return Buffer.alloc(0);
        })(),
      }),
    );
    // Simpler: use web3 SystemProgram via require to keep types happy.
    const { SystemProgram } = await import("@solana/web3.js");
    const tx2 = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: treasury.publicKey,
        newAccountPubkey: mint,
        lamports: rent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint, 6, treasury.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        treasury.publicKey, treasuryAta, treasury.publicKey, mint),
      createAssociatedTokenAccountIdempotentInstruction(
        treasury.publicKey, buyerAta, buyer.publicKey, mint),
      createMintToInstruction(mint, treasuryAta, treasury.publicKey, 100_000_000n), // $100 reserves
      createMintToInstruction(mint, buyerAta, treasury.publicKey, 1_000_000_000n), // $1000 buyer
    );
    void tx;
    await sendAndConfirmTransaction(conn, tx2, [treasury, mintKp], { commitment: "finalized" });
  }
  console.log(`  mint ${mint.toBase58()}  treasuryAta ${treasuryAta.toBase58()}`);

  console.log("3. Ledger + quote (synthetic SOL/USDC-like position, 60s tenor)");
  const config: LedgerConfig = {
    uMaxBps: 3000, protocolFeeBps: 150, premiumFloorUsdc: 1_500_000,
    markupFloor: 1.05, feeSplitRate: 0.1, expectedDailyFee: 0.005,
    tenorSeconds: TENOR_S, quoteTtlSeconds: 600, regimeMaxAgeSeconds: 900,
    perBuyerCapDownLimitUsdc: 0,
    maxOpenQuotesPerOwner: 5,
    maxLifetimeQuotes: 100_000,
    masterTermsVersion: "0.1-draft", masterTermsHash: sha256Hex("draft"),
    treasuryAddress: treasury.publicKey.toBase58(),
  };
  let n = 0;
  const ledger = new CertificateLedger(
    config,
    { now: () => Math.floor(Date.now() / 1000) },
    { quoteId: () => `RQ${++n}`, referenceKey: () => `LHREH-${Date.now()}` },
    100_000_000,
  );
  const position: HedgedPositionInput = {
    positionMint: "rehearsal-pos", ownerWallet: buyer.publicKey.toBase58(),
    whirlpool: "rehearsal-pool", liquidity: 10_000_000_000n,
    tickLower: -20000, tickUpper: -18000, decimalsA: 9, decimalsB: 6,
    currentPriceUsd: 150,
  };
  const quote = ledger.issueQuote(position, {
    sigmaAnnual: 0.65, ivRvRatio: 1.08,
    regimeUpdatedAtTs: Math.floor(Date.now() / 1000),
  });
  console.log(
    `  premium $${(quote.premiumUsdc / 1e6).toFixed(4)}  collateral $${(quote.capUpUsdc / 1e6).toFixed(4)}` +
      `  total $${(quote.totalPayableUsdc / 1e6).toFixed(4)}  ref ${quote.referenceKey}`,
  );

  console.log("4. Buyer pays EXACT amount + memo reference on-chain (finalized)");
  const payTx = new Transaction().add(
    createTransferCheckedInstruction(
      buyerAta, mint, treasuryAta, buyer.publicKey, BigInt(quote.totalPayableUsdc), 6),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: buyer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(quote.referenceKey, "utf8"),
    }),
  );
  const paySig = await sendAndConfirmTransaction(conn, payTx, [buyer], { commitment: "finalized" });
  console.log(`  paid: ${paySig.slice(0, 16)}…`);

  console.log("5. PRODUCTION RUNNER takes over (scan → activate → settle → payout)");
  // Real devnet ports: the same adapters the pilot will use.
  const ports: RunnerPorts = {
    scanPayments: async (until) => {
      const r = await scanTreasuryPayments(conn, treasuryAta, mint, {
        untilSignature: until ?? undefined,
      });
      return { transfers: r.transfers, cursor: r.cursor };
    },
    // Rehearsal oracle: synthetic agreed price (the oracle policy is a
    // separate port; AR-7 divergence handling is covered by unit tests).
    readSettlementPrice: async () => ({
      priceUsd: 145,
      slot: 0,
      crossCheckPriceUsd: 145,
      divergenceBps: 0,
    }),
    // Synthetic position → no real accrued fees; 0 is the buyer-favorable
    // contract default (Master Terms §7.2).
    readAccruedFees: async () => 0,
    executePayout: async (payout) => {
      const tx = new Transaction().add(
        ...buildPayoutInstructions({
          fromWallet: treasury.publicKey,
          toWallet: new PublicKey(payout.to),
          usdcMint: mint,
          amountUsdc: payout.amountUsdc,
          memo: payout.memo,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [treasury], {
        commitment: "finalized",
      });
      return { txSignature: sig };
    },
    hotWalletBalanceUsdc: async () =>
      Number((await getAccount(conn, treasuryAta)).amount),
  };
  const runCfg = {
    hotWalletFloatCapUsdc: 1_000_000_000,
    minRefundUsdc: 100_000,
    maxDivergenceBps: 100,
    dryRun: false,
  };

  const before = (await getAccount(conn, buyerAta)).amount;
  const cycle1 = await runSettlementCycle(ledger, ports, runCfg, null);
  console.log(
    `  cycle 1: observed=${cycle1.observedPayments} activated=[${cycle1.activated}] invariants=${cycle1.invariantsOk}`,
  );
  if (cycle1.activated.length !== 1) {
    throw new Error("REHEARSAL FAILED: runner did not activate the certificate");
  }

  console.log(`6. Waiting ${TENOR_S + 3}s for expiry…`);
  await new Promise((r) => setTimeout(r, (TENOR_S + 3) * 1000));

  const cycle2 = await runSettlementCycle(ledger, ports, runCfg, cycle1.cursor);
  const settled = cycle2.settled[0];
  console.log(
    `  cycle 2: settled ${settled?.reference} → $${((settled?.amountUsdc ?? 0) / 1e6).toFixed(4)} ` +
      `tx=${settled?.executedTx?.slice(0, 16)}… failedPayouts=${cycle2.failedPayouts.length}`,
  );
  if (!settled?.executedTx) {
    throw new Error("REHEARSAL FAILED: runner did not execute the settlement payout");
  }
  const after = (await getAccount(conn, buyerAta)).amount;
  if (Number(after - before) !== settled.amountUsdc) {
    throw new Error("REHEARSAL FAILED: on-chain payout != ledger settlement amount");
  }

  const mon = ledger.monitor();
  console.log(
    `\nREHEARSAL PASSED (production runner) ✔  invariants=${mon.invariants.ok}  ` +
      `netReserves $${(mon.netReservesUsdc / 1e6).toFixed(2)}  events=${ledger.getEvents().length}`,
  );
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
