#!/usr/bin/env ts-node
/**
 * One-shot pool snapshot capture.
 *   RPC_URL=... POOLS=addr1,addr2 SNAPSHOT_DIR=... pnpm --filter @lh/ops-jobs snapshot-once
 * Defaults: canonical SOL/USDC pool; dir platform/.data/pool-snapshots;
 * RPC from env or lh-protocol/.env (like the other CLIs).
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Connection } from "@solana/web3.js";
import { FilePoolSnapshotStore } from "@lh/market-data";
import { captureSnapshots, DEFAULT_POOLS } from "./pool-snapshot-job";

async function main() {
  let rpc = process.env.RPC_URL;
  if (!rpc) {
    const envPath = resolve(__dirname, "../../../../lh-protocol/.env");
    if (existsSync(envPath)) {
      rpc = readFileSync(envPath, "utf8").match(/^ANCHOR_PROVIDER_URL=(.+)$/m)?.[1]?.trim();
    }
  }
  if (!rpc) {
    console.error("RPC_URL missing");
    process.exit(1);
  }
  const pools = process.env.POOLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_POOLS;
  const dir =
    process.env.SNAPSHOT_DIR ?? resolve(__dirname, "../../../.data/pool-snapshots");

  const store = new FilePoolSnapshotStore(dir);
  const connection = new Connection(rpc, "confirmed");

  const once = async () => {
    const result = await captureSnapshots(
      connection,
      store,
      pools,
      Math.floor(Date.now() / 1000),
    );
    for (const c of result.captured) {
      console.log(
        `${c.pool}: price=${c.snapshot.price.toFixed(4)} L_active=${c.snapshot.liquidity} ` +
          `fgA=${c.snapshot.feeGrowthGlobalA} fgB=${c.snapshot.feeGrowthGlobalB}`,
      );
    }
    if (result.missing.length > 0) {
      console.error(`missing accounts: ${result.missing.join(", ")}`);
      if (!loopSeconds) process.exit(2);
    }
  };

  // SNAPSHOT_LOOP_SECONDS turns the one-shot into a resident collector
  // (used by the deploy stack); errors are logged, the loop survives.
  const loopSeconds = Number(process.env.SNAPSHOT_LOOP_SECONDS ?? 0);
  await once();
  if (loopSeconds > 0) {
    console.log(`collector mode: every ${loopSeconds}s`);
    setInterval(() => {
      once().catch((e) => console.error("snapshot cycle failed:", e.message ?? e));
    }, loopSeconds * 1000);
  }
}

main().catch((e) => {
  console.error("snapshot capture failed:", e.message ?? e);
  process.exit(1);
});
