/**
 * Operator Service — settlement loop + reserve reconciliation.
 *
 * Scans active certificates and settles those past expiry.
 * Runs every 60 seconds.
 *
 * Usage: PYTH_PRICE_FEED=<pubkey> npx ts-node clients/operator-service/index.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../../target/types/lh_core";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

const SCAN_INTERVAL_MS = 60_000; // 60 seconds

async function scanAndSettle(program: Program<LhCore>, settler: PublicKey) {
  const now = Math.floor(Date.now() / 1000);

  // Fetch all certificate accounts
  const certs = await program.account.certificateState.all();
  const activeCerts = certs.filter((c) => c.account.state === 1); // ACTIVE

  if (activeCerts.length === 0) {
    console.log(`[${new Date().toISOString()}] No active certificates`);
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Found ${activeCerts.length} active certificate(s)`
  );

  const pythFeed = process.env.PYTH_PRICE_FEED;
  if (!pythFeed) {
    console.log("  PYTH_PRICE_FEED not set — skipping settlement");
    return;
  }

  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool")],
    program.programId
  );
  const pool = await program.account.poolState.fetch(poolState);

  for (const cert of activeCerts) {
    const c = cert.account;
    const expiryTs = c.expiryTs.toNumber();

    if (now < expiryTs) {
      const remaining = expiryTs - now;
      console.log(
        `  ${cert.publicKey.toBase58().slice(0, 12)}... expires in ${Math.round(remaining / 3600)}h`
      );
      continue;
    }

    console.log(
      `  ${cert.publicKey.toBase58().slice(0, 12)}... EXPIRED — settling...`
    );

    try {
      // Find the position state for this certificate
      const positionState = c.position;

      // Derive the owner's USDC ATA for payout
      const ownerUsdcAta = await getAssociatedTokenAddress(
        pool.usdcMint,
        c.owner,
      );

      await program.methods
        .settleCertificate()
        .accountsPartial({
          settler,
          certificateState: cert.publicKey,
          positionState: c.position,
          poolState,
          usdcVault: pool.usdcVault,
          ownerUsdc: ownerUsdcAta,
          pythPriceFeed: new PublicKey(pythFeed),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log(`    ✓ Settled successfully`);
    } catch (e: any) {
      if (e.toString().includes("StaleOracle")) {
        console.log(`    ⏳ Oracle stale — will retry next cycle`);
      } else if (e.toString().includes("TooEarly")) {
        console.log(`    ⏳ Not yet expired — clock skew?`);
      } else {
        console.error(`    ✗ Settlement failed:`, e.message || e.toString());
      }
    }
  }
}

async function reconcileReserves(program: Program<LhCore>) {
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool")],
    program.programId
  );

  try {
    const pool = await program.account.poolState.fetch(poolState);
    const provider = program.provider as anchor.AnchorProvider;
    const vaultAccount = await getAccount(provider.connection, pool.usdcVault);
    const vaultBalance = Number(vaultAccount.amount);
    const stateReserves = pool.reservesUsdc.toNumber();

    if (vaultBalance !== stateReserves) {
      console.log(
        `  ⚠ Reserve mismatch: vault=${vaultBalance / 1e6} USDC, ` +
        `state=${stateReserves / 1e6} USDC, ` +
        `diff=${(vaultBalance - stateReserves) / 1e6} USDC`
      );
    } else {
      console.log(`  Reserves OK: ${stateReserves / 1e6} USDC`);
    }
  } catch (e: any) {
    console.error("  Reserve check failed:", e.message);
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const settler = provider.wallet.publicKey;

  console.log("Operator Service starting...");
  console.log(`  Program: ${program.programId.toBase58()}`);
  console.log(`  Settler: ${settler.toBase58()}`);
  console.log(`  Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);

  // Run once immediately
  await scanAndSettle(program, settler);
  await reconcileReserves(program);

  // Loop
  if (process.env.ONCE !== "true") {
    setInterval(async () => {
      try {
        await scanAndSettle(program, settler);
        await reconcileReserves(program);
      } catch (e) {
        console.error("Scan cycle failed:", e);
      }
    }, SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
