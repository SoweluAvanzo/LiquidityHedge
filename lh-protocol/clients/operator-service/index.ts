/**
 * Operator Service — settlement loop + reserve reconciliation.
 *
 * Scans active certificates and settles those past expiry.
 * Includes idempotency checks, error categorization, regime staleness
 * detection, and graceful shutdown.
 *
 * Usage: PYTH_PRICE_FEED=<pubkey> npx ts-node clients/operator-service/index.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../../target/types/lh_core";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || "60000", 10);
const MAX_SETTLE_RETRIES = 2;
const REGIME_STALE_THRESHOLD_S = 900; // 15 minutes

// ─── State ───────────────────────────────────────────────────────────

let cycleCount = 0;
let totalSettled = 0;
let totalFailed = 0;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ─── Transient vs Permanent Errors ───────────────────────────────────

const TRANSIENT_ERRORS = [
  "blockhash",
  "timeout",
  "connection",
  "429",
  "503",
  "ECONNREFUSED",
  "ETIMEDOUT",
];

const PERMANENT_ERRORS = [
  "NotActive",
  "AlreadySettled",
  "InvalidPositionStatus",
  "Unauthorized",
  "InsufficientReserves",
];

function isTransientError(errMsg: string): boolean {
  return TRANSIENT_ERRORS.some((t) => errMsg.toLowerCase().includes(t.toLowerCase()));
}

function isPermanentError(errMsg: string): boolean {
  return PERMANENT_ERRORS.some((t) => errMsg.includes(t));
}

// ─── Regime Staleness Check ──────────────────────────────────────────

async function checkRegimeStaleness(program: Program<LhCore>) {
  try {
    const [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool")],
      program.programId
    );
    const [regimePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("regime"), poolState.toBuffer()],
      program.programId
    );

    const regime = await program.account.regimeSnapshot.fetch(regimePda);
    const now = Math.floor(Date.now() / 1000);
    const age = now - regime.updatedTs.toNumber();

    if (age > REGIME_STALE_THRESHOLD_S) {
      log(
        "WARN",
        `RegimeSnapshot is stale: ${age}s old (threshold=${REGIME_STALE_THRESHOLD_S}s). ` +
        `Certificates cannot be purchased with stale regime.`
      );
    }
  } catch (e: any) {
    log("WARN", `Could not check regime staleness: ${e.message}`);
  }
}

// ─── Settlement Loop ─────────────────────────────────────────────────

async function scanAndSettle(program: Program<LhCore>, settler: PublicKey) {
  cycleCount++;
  const now = Math.floor(Date.now() / 1000);
  let settled = 0;
  let skipped = 0;
  let failed = 0;

  // Fetch all certificate accounts
  const certs = await program.account.certificateState.all();
  const activeCerts = certs.filter((c) => c.account.state === 1);

  if (activeCerts.length === 0) {
    log("INFO", `Cycle #${cycleCount}: no active certificates`);
    return;
  }

  log("INFO", `Cycle #${cycleCount}: ${activeCerts.length} active certificate(s)`);

  const pythFeed = process.env.PYTH_PRICE_FEED || process.env.PYTH_SOL_USD_FEED;
  if (!pythFeed) {
    log("WARN", "PYTH_PRICE_FEED not set — skipping settlement");
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
      log("INFO", `  ${shortKey(cert.publicKey)} expires in ${formatDuration(remaining)}`);
      skipped++;
      continue;
    }

    // Idempotency: re-fetch certificate to verify it's still ACTIVE
    try {
      const freshCert = await program.account.certificateState.fetch(cert.publicKey);
      if (freshCert.state !== 1) {
        log("INFO", `  ${shortKey(cert.publicKey)} already settled/expired (state=${freshCert.state}), skipping`);
        skipped++;
        continue;
      }
    } catch (e: any) {
      log("WARN", `  ${shortKey(cert.publicKey)} could not re-fetch: ${e.message}`);
      skipped++;
      continue;
    }

    log("INFO", `  ${shortKey(cert.publicKey)} EXPIRED — settling...`);

    // Attempt settlement with retry for transient errors
    let success = false;
    for (let attempt = 1; attempt <= MAX_SETTLE_RETRIES; attempt++) {
      try {
        const ownerUsdcAta = await getAssociatedTokenAddress(
          pool.usdcMint,
          c.owner
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

        log("INFO", `    Settled successfully`);
        settled++;
        totalSettled++;
        success = true;
        break;
      } catch (e: any) {
        const errMsg = e.message || e.toString();

        if (isPermanentError(errMsg)) {
          log("ERROR", `    Permanent error (will not retry): ${errMsg}`);
          failed++;
          totalFailed++;
          break;
        }

        if (isTransientError(errMsg) && attempt < MAX_SETTLE_RETRIES) {
          log("WARN", `    Transient error (attempt ${attempt}/${MAX_SETTLE_RETRIES}): ${errMsg}`);
          await sleep(2000 * attempt);
          continue;
        }

        if (errMsg.includes("StaleOracle")) {
          log("WARN", `    Oracle stale — will retry next cycle`);
        } else if (errMsg.includes("TooEarly")) {
          log("WARN", `    Not yet expired — clock skew, will retry next cycle`);
        } else {
          log("ERROR", `    Settlement failed: ${errMsg}`);
        }
        failed++;
        totalFailed++;
        break;
      }
    }
  }

  log(
    "INFO",
    `Cycle #${cycleCount} complete: settled=${settled}, skipped=${skipped}, failed=${failed} ` +
    `(lifetime: settled=${totalSettled}, failed=${totalFailed})`
  );
}

// ─── Reserve Reconciliation ──────────────────────────────────────────

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
      log(
        "WARN",
        `Reserve mismatch: vault=${(vaultBalance / 1e6).toFixed(6)} USDC, ` +
        `state=${(stateReserves / 1e6).toFixed(6)} USDC, ` +
        `diff=${((vaultBalance - stateReserves) / 1e6).toFixed(6)} USDC`
      );
    }
  } catch (e: any) {
    log("WARN", `Reserve check failed: ${e.message}`);
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────

function setupShutdown() {
  const shutdown = () => {
    log("INFO", "Shutting down...");
    if (intervalHandle) clearInterval(intervalHandle);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function log(level: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [operator] [${level}] ${msg}`);
}

function shortKey(pubkey: PublicKey): string {
  return pubkey.toBase58().slice(0, 12) + "...";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Entry Point ─────────────────────────────────────────────────────

async function main() {
  setupShutdown();

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const settler = provider.wallet.publicKey;

  log("INFO", "Starting...");
  log("INFO", `Program: ${program.programId.toBase58()}`);
  log("INFO", `Settler: ${settler.toBase58()}`);
  log("INFO", `Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);

  // Check regime first
  await checkRegimeStaleness(program);

  // Run once
  await scanAndSettle(program, settler);
  await reconcileReserves(program);

  if (process.env.ONCE !== "true") {
    intervalHandle = setInterval(async () => {
      try {
        await checkRegimeStaleness(program);
        await scanAndSettle(program, settler);
        await reconcileReserves(program);
      } catch (e: any) {
        log("ERROR", `Scan cycle failed: ${e.message || e}`);
      }
    }, SCAN_INTERVAL_MS);
  }
}

main().catch((e) => {
  log("ERROR", `Fatal: ${e}`);
  process.exit(1);
});
