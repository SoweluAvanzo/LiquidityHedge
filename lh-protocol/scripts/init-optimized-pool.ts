/**
 * Initialize pool and templates with optimized parameters from simulation study.
 *
 * Usage: npx ts-node scripts/init-optimized-pool.ts
 *
 * Requires: VAULT_KEYPAIR_PATH, ANCHOR_PROVIDER_URL in .env
 */

import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { OffchainLhProtocol } from "../protocol/offchain-emulator/index";
import { USDC_MINT } from "../clients/cli/config";
import {
  OPTIMIZED_TEMPLATES,
  OPTIMIZED_POOL,
} from "../protocol/offchain-emulator/config/templates";

async function main() {
  const rpc = process.env.ANCHOR_PROVIDER_URL;
  if (!rpc) throw new Error("ANCHOR_PROVIDER_URL not set");

  const vaultPath = process.env.VAULT_KEYPAIR_PATH ?? "./wallet-vault.json";
  const vaultKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(vaultPath, "utf-8")))
  );
  const adminKeypair = vaultKeypair; // admin = vault in PoC

  const connection = new Connection(rpc, "confirmed");
  const dataDir = path.resolve(__dirname,
    `../protocol/offchain-emulator/data/optimized-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`
  );
  fs.mkdirSync(dataDir, { recursive: true });

  const protocol = new OffchainLhProtocol(connection, vaultKeypair, dataDir);

  console.log("═".repeat(70));
  console.log("INITIALIZING POOL WITH OPTIMIZED PARAMETERS");
  console.log("═".repeat(70));

  console.log("\n1. Pool initialization:");
  console.log(`   u_max:              ${OPTIMIZED_POOL.uMaxBps} bps (${OPTIMIZED_POOL.uMaxBps / 100}%)`);
  console.log(`   fee share:          ${OPTIMIZED_POOL.feeShareMinBps}-${OPTIMIZED_POOL.feeShareMaxBps} bps`);
  console.log(`   early exit penalty: ${OPTIMIZED_POOL.earlyExitPenaltyBps} bps (${OPTIMIZED_POOL.earlyExitPenaltyBps / 100}%)`);
  console.log(`   protocol fee:       ${OPTIMIZED_POOL.protocolFeeBps} bps (${OPTIMIZED_POOL.protocolFeeBps / 100}%)`);
  console.log(`   RT width mult:      ${OPTIMIZED_POOL.rtTickWidthMultiplier}×`);

  await protocol.initPool(adminKeypair, USDC_MINT, OPTIMIZED_POOL.uMaxBps, {
    premiumUpfrontBps: OPTIMIZED_POOL.premiumUpfrontBps,
    feeShareMinBps: OPTIMIZED_POOL.feeShareMinBps,
    feeShareMaxBps: OPTIMIZED_POOL.feeShareMaxBps,
    earlyExitPenaltyBps: OPTIMIZED_POOL.earlyExitPenaltyBps,
    rtTickWidthMultiplier: OPTIMIZED_POOL.rtTickWidthMultiplier,
    protocolFeeBps: OPTIMIZED_POOL.protocolFeeBps,
  });
  console.log("   ✓ Pool created");

  // 2. Create templates
  console.log("\n2. Templates:");
  for (const tmpl of OPTIMIZED_TEMPLATES) {
    await protocol.createTemplate(adminKeypair, {
      templateId: tmpl.templateId,
      tenorSeconds: tmpl.tenorSeconds,
      widthBps: tmpl.widthBps,
      severityPpm: tmpl.severityPpm,
      premiumFloorUsdc: tmpl.premiumFloorUsdc,
      premiumCeilingUsdc: tmpl.premiumCeilingUsdc,
    });
    console.log(`   ✓ Template ${tmpl.templateId} (${tmpl.label}):`);
    console.log(`     width=${tmpl.widthBps}bps, severity=${tmpl.severityPpm.toLocaleString()}, tenor=${tmpl.tenorSeconds / 86400}d`);
    console.log(`     fee share=${tmpl.feeShareBps}bps, expected fee rate=${(tmpl.expectedDailyFeeRate * 100).toFixed(2)}%/day`);
  }

  // 3. Publish initial regime snapshot (will be updated by risk service)
  console.log("\n3. Initial regime snapshot:");
  const defaultSigma = 650_000;    // 65% = 650,000 PPM
  const defaultSigmaMa = 650_000;  // same for initial
  const defaultCarry = 10;          // 10 bps/day
  await protocol.updateRegimeSnapshot(adminKeypair, {
    sigmaPpm: defaultSigma,
    sigmaMaPpm: defaultSigmaMa,
    stressFlag: false,
    carryBpsPerDay: defaultCarry,
  });
  console.log(`   ✓ Regime: σ=${defaultSigma / 10_000}%, σ_ma=${defaultSigmaMa / 10_000}%, stress=false, carry=${defaultCarry}bps/day`);

  console.log("\n" + "═".repeat(70));
  console.log("INITIALIZATION COMPLETE");
  console.log("═".repeat(70));
  console.log(`\nState saved to: ${dataDir}/protocol-state.json`);
  console.log(`Audit log: ${dataDir}/audit.jsonl`);
  console.log("\nNext steps:");
  console.log("  1. Start risk service:    npm run risk-service");
  console.log("  2. Start operator service: npm run operator-service");
  console.log("  3. Fund LP and RT wallets with SOL + USDC");
  console.log("  4. LP opens position:     npm run open-and-lock -- --width 200");
  console.log("  5. LP buys certificate (auto barrier=90%, auto natural cap)");
}

main().catch(console.error);
