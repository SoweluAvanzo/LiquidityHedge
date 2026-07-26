#!/usr/bin/env node
/**
 * Phase-0 data-vendor spike (G0 exit criterion, §E7):
 * verify how much OHLCV history Birdeye actually serves for SOL/USDC,
 * for both daily (empirical Monte Carlo needs 1–3 y) and 15-min candles
 * (realized-vol estimation needs 30 d).
 *
 * Reads BIRDEYE_API_KEY from lh-protocol/.env (never hardcode keys).
 * Usage: node platform/tools/birdeye-depth-check.mjs
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envText = readFileSync(resolve(repoRoot, "lh-protocol/.env"), "utf8");
const apiKey = envText.match(/^BIRDEYE_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) {
  console.error("BIRDEYE_API_KEY not found in lh-protocol/.env");
  process.exit(1);
}

const SOL = "So11111111111111111111111111111111111111112";
const BASE = "https://public-api.birdeye.so/defi/ohlcv";

async function probe(type, daysBack, label) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - daysBack * 86_400;
  const url = `${BASE}?address=${SOL}&type=${type}&time_from=${from}&time_to=${now}`;
  const res = await fetch(url, {
    headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
  });
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} ${res.statusText}`);
    return;
  }
  const body = await res.json();
  const items = body?.data?.items ?? [];
  if (items.length === 0) {
    console.log(`${label}: 0 candles returned`);
    return;
  }
  const first = new Date(items[0].unixTime * 1000).toISOString().slice(0, 10);
  const last = new Date(items[items.length - 1].unixTime * 1000)
    .toISOString()
    .slice(0, 10);
  const spanDays = ((items[items.length - 1].unixTime - items[0].unixTime) / 86_400).toFixed(0);
  console.log(
    `${label}: ${items.length} candles, ${first} → ${last} (${spanDays} days of depth)`,
  );
}

console.log("Birdeye OHLCV depth spike — SOL (wSOL mint), key from lh-protocol/.env\n");
await probe("1D", 3 * 365, "1D candles, requested 3y");
await probe("1D", 2 * 365, "1D candles, requested 2y");
await probe("1D", 365, "1D candles, requested 1y");
await probe("15m", 30, "15m candles, requested 30d");
