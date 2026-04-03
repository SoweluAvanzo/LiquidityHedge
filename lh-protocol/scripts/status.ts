/**
 * status.ts — Read and display protocol state.
 *
 * Usage: npx ts-node scripts/status.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../target/types/lh_core";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;

  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool")],
    program.programId
  );

  console.log("=== Liquidity Hedge Protocol Status ===\n");
  console.log("Program:", program.programId.toBase58());

  // Pool
  try {
    const pool = await program.account.poolState.fetch(poolState);
    const utilization =
      pool.reservesUsdc.toNumber() > 0
        ? ((pool.activeCapUsdc.toNumber() / pool.reservesUsdc.toNumber()) * 100).toFixed(2)
        : "0.00";
    const nav =
      pool.totalShares.toNumber() > 0
        ? (pool.reservesUsdc.toNumber() / pool.totalShares.toNumber()).toFixed(6)
        : "N/A";

    console.log("\n--- Pool ---");
    console.log(`  Admin:          ${pool.admin.toBase58()}`);
    console.log(`  Reserves:       ${(pool.reservesUsdc.toNumber() / 1e6).toFixed(2)} USDC`);
    console.log(`  Active Cap:     ${(pool.activeCapUsdc.toNumber() / 1e6).toFixed(2)} USDC`);
    console.log(`  Total Shares:   ${(pool.totalShares.toNumber() / 1e6).toFixed(2)}`);
    console.log(`  U_max:          ${(pool.uMaxBps / 100).toFixed(1)}%`);
    console.log(`  Utilization:    ${utilization}%`);
    console.log(`  NAV/share:      ${nav}`);
  } catch {
    console.log("\n--- Pool: NOT INITIALIZED ---");
    return;
  }

  // Regime
  const [regimePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("regime"), poolState.toBuffer()],
    program.programId
  );
  try {
    const regime = await program.account.regimeSnapshot.fetch(regimePda);
    const age = Math.floor(Date.now() / 1000) - regime.updatedTs.toNumber();
    console.log("\n--- Regime Snapshot ---");
    console.log(`  Sigma:          ${(regime.sigmaPpm.toNumber() / 10_000).toFixed(2)}%`);
    console.log(`  Sigma MA:       ${(regime.sigmaMaPpm.toNumber() / 10_000).toFixed(2)}%`);
    console.log(`  Stress:         ${regime.stressFlag}`);
    console.log(`  Carry:          ${regime.carryBpsPerDay} bps/day`);
    console.log(`  Age:            ${age}s`);
  } catch {
    console.log("\n--- Regime: NOT SET ---");
  }

  // Templates
  for (let id = 1; id <= 5; id++) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(id);
    const [tplPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("template"), buf],
      program.programId
    );
    try {
      const t = await program.account.templateConfig.fetch(tplPda);
      console.log(`\n--- Template ${id} ---`);
      console.log(`  Tenor:          ${t.tenorSeconds.toNumber()}s (${(t.tenorSeconds.toNumber() / 86_400).toFixed(2)} days)`);
      console.log(`  Width:          ${(t.widthBps / 100).toFixed(1)}%`);
      console.log(`  Severity:       ${(t.severityPpm.toNumber() / 10_000).toFixed(1)}%`);
      console.log(`  Floor:          ${(t.premiumFloorUsdc.toNumber() / 1e6).toFixed(4)} USDC`);
      console.log(`  Ceiling:        ${(t.premiumCeilingUsdc.toNumber() / 1e6).toFixed(2)} USDC`);
      console.log(`  Active:         ${t.active}`);
    } catch {
      break; // No more templates
    }
  }

  // Scan for positions (by fetching all PositionState accounts)
  const positions = await program.account.positionState.all();
  if (positions.length > 0) {
    console.log(`\n--- Positions (${positions.length}) ---`);
    for (const p of positions) {
      const st = p.account.status === 1 ? "LOCKED" : p.account.status === 2 ? "RELEASED" : "CLOSED";
      console.log(`  ${p.publicKey.toBase58().slice(0, 12)}... | ${st} | p0=$${(p.account.p0PriceE6.toNumber() / 1e6).toFixed(2)} | protected=${p.account.protectedBy !== null}`);
    }
  }

  // Scan for certificates
  const certs = await program.account.certificateState.all();
  if (certs.length > 0) {
    console.log(`\n--- Certificates (${certs.length}) ---`);
    for (const c of certs) {
      const st = ["CREATED", "ACTIVE", "SETTLED", "EXPIRED"][c.account.state] || "UNKNOWN";
      const expiry = new Date(c.account.expiryTs.toNumber() * 1000).toISOString();
      console.log(`  ${c.publicKey.toBase58().slice(0, 12)}... | ${st} | cap=${(c.account.capUsdc.toNumber() / 1e6).toFixed(2)} | premium=${(c.account.premiumUsdc.toNumber() / 1e6).toFixed(2)} | expires=${expiry}`);
    }
  }
}

main().catch(console.error);
