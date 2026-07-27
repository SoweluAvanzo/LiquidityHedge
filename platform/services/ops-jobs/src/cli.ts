#!/usr/bin/env ts-node
/**
 * One-shot regime update against live sources.
 * Usage: BIRDEYE_API_KEY=... pnpm --filter @lh/ops-jobs regime-once
 * (reads lh-protocol/.env as a fallback for the key, like the other tools)
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { makeBirdeyeFetcher } from "@lh/market-data";
import { fetchSolAtmImpliedVol } from "@lh/core/src/market-data/binance-iv-adapter";
import { computeMarketInputs } from "./regime-updater";
import { secretEnv } from "@lh/storage";

async function main() {
  let apiKey = secretEnv("BIRDEYE_API_KEY");
  if (!apiKey) {
    const envPath = resolve(__dirname, "../../../../lh-protocol/.env");
    if (existsSync(envPath)) {
      apiKey = readFileSync(envPath, "utf8").match(/^BIRDEYE_API_KEY=(.+)$/m)?.[1]?.trim();
    }
  }
  if (!apiKey) {
    console.error("BIRDEYE_API_KEY missing");
    process.exit(1);
  }

  const result = await computeMarketInputs({
    candleFetcher: makeBirdeyeFetcher(apiKey),
    ivSource: {
      fetchIv: async (tenorSeconds) => {
        const est = await fetchSolAtmImpliedVol(tenorSeconds);
        return est ? { iv: est.markIV, label: `binance:${est.symbol}` } : null;
      },
    },
    nowTs: Math.floor(Date.now() / 1000),
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("regime update REFUSED:", e.message);
  process.exit(2);
});
