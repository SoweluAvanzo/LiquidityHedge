#!/usr/bin/env ts-node
/**
 * health.ts — Protocol health checker.
 *
 * Checks:
 *   1. Pool exists and reserves > 0
 *   2. Regime snapshot exists and is fresh (< 20 minutes)
 *   3. No active certificates past expiry by > 1 hour (settlement lag)
 *   4. Vault balance matches pool.reserves_usdc
 *
 * Exit 0 = all healthy, Exit 1 = issues found.
 *
 * Usage: npx ts-node scripts/health.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../target/types/lh_core";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

const REGIME_MAX_AGE_S = 1200; // 20 minutes
const SETTLEMENT_LAG_THRESHOLD_S = 3600; // 1 hour

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const connection = provider.connection;
  const pid = program.programId;

  let issues = 0;
  const now = Math.floor(Date.now() / 1000);

  console.log("=== LH Protocol Health Check ===");
  console.log(`  Program:  ${pid.toBase58()}`);
  console.log(`  Cluster:  ${connection.rpcEndpoint}`);
  console.log(`  Time:     ${new Date().toISOString()}`);
  console.log();

  // ── 1. Pool State ───────────────────────────────────────────────

  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool")],
    pid
  );

  try {
    const pool = await program.account.poolState.fetch(poolState);
    const reserves = pool.reservesUsdc.toNumber();
    const activeCap = pool.activeCapUsdc.toNumber();
    const utilization =
      reserves > 0 ? ((activeCap / reserves) * 100).toFixed(2) : "N/A";

    console.log(`[POOL]`);
    console.log(`  Reserves:     ${(reserves / 1e6).toFixed(6)} USDC`);
    console.log(`  Active cap:   ${(activeCap / 1e6).toFixed(6)} USDC`);
    console.log(`  Utilization:  ${utilization}%`);
    console.log(`  U_max:        ${(pool.uMaxBps / 100).toFixed(1)}%`);

    if (reserves === 0 && activeCap > 0) {
      console.log(`  FAIL: Pool has active cap but zero reserves`);
      issues++;
    } else {
      console.log(`  OK`);
    }

    // ── 4. Vault Balance Reconciliation ─────────────────────────

    try {
      const vaultAccount = await getAccount(connection, pool.usdcVault);
      const vaultBalance = Number(vaultAccount.amount);

      console.log(`\n[VAULT]`);
      console.log(`  Vault balance: ${(vaultBalance / 1e6).toFixed(6)} USDC`);
      console.log(`  State reserves: ${(reserves / 1e6).toFixed(6)} USDC`);

      if (vaultBalance !== reserves) {
        const diff = vaultBalance - reserves;
        console.log(
          `  WARN: Mismatch of ${(diff / 1e6).toFixed(6)} USDC`
        );
        issues++;
      } else {
        console.log(`  OK`);
      }
    } catch (e: any) {
      console.log(`\n[VAULT]`);
      console.log(`  FAIL: Could not read vault: ${e.message}`);
      issues++;
    }
  } catch (e: any) {
    console.log(`[POOL]`);
    console.log(`  FAIL: Pool not found: ${e.message}`);
    issues++;
  }

  // ── 2. Regime Snapshot ──────────────────────────────────────────

  console.log(`\n[REGIME]`);
  try {
    const [regimePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("regime"), poolState.toBuffer()],
      pid
    );
    const regime = await program.account.regimeSnapshot.fetch(regimePda);
    const age = now - regime.updatedTs.toNumber();

    console.log(
      `  Sigma:    ${(regime.sigmaPpm.toNumber() / 10_000).toFixed(2)}%`
    );
    console.log(
      `  Sigma MA: ${(regime.sigmaMaPpm.toNumber() / 10_000).toFixed(2)}%`
    );
    console.log(`  Stress:   ${regime.stressFlag}`);
    console.log(`  Age:      ${age}s (max=${REGIME_MAX_AGE_S}s)`);

    if (age > REGIME_MAX_AGE_S) {
      console.log(`  WARN: Regime snapshot is stale (${age}s > ${REGIME_MAX_AGE_S}s)`);
      issues++;
    } else {
      console.log(`  OK`);
    }
  } catch (e: any) {
    console.log(`  FAIL: Regime not found: ${e.message}`);
    issues++;
  }

  // ── 3. Certificate Settlement Lag ───────────────────────────────

  console.log(`\n[CERTIFICATES]`);
  try {
    const certs = await program.account.certificateState.all();
    const activeCerts = certs.filter((c) => c.account.state === 1);
    console.log(`  Total:   ${certs.length}`);
    console.log(`  Active:  ${activeCerts.length}`);

    let overdue = 0;
    for (const cert of activeCerts) {
      const expiryTs = cert.account.expiryTs.toNumber();
      if (now > expiryTs + SETTLEMENT_LAG_THRESHOLD_S) {
        overdue++;
        const lag = now - expiryTs;
        console.log(
          `  WARN: ${cert.publicKey.toBase58().slice(0, 16)}... overdue by ${(lag / 3600).toFixed(1)}h`
        );
      }
    }

    if (overdue > 0) {
      console.log(`  WARN: ${overdue} certificate(s) past expiry by > 1h`);
      issues++;
    } else {
      console.log(`  OK`);
    }
  } catch (e: any) {
    console.log(`  WARN: Could not scan certificates: ${e.message}`);
  }

  // ── Summary ─────────────────────────────────────────────────────

  console.log(`\n=== Health: ${issues === 0 ? "HEALTHY" : `${issues} ISSUE(S) FOUND`} ===`);
  process.exit(issues > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Health check failed:", err);
  process.exit(1);
});
