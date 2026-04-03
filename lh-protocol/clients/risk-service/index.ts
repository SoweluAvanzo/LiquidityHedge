/**
 * Risk Service — fetches market data, computes volatility, publishes RegimeSnapshot.
 *
 * For the PoC, this uses a simplified volatility model:
 * - Fetch SOL/USDC price history from Birdeye (or mock data)
 * - Compute realized volatility from log returns
 * - Compute moving average of sigma
 * - Determine stress flag (sigma/sigma_ma > threshold)
 * - Publish RegimeSnapshot on-chain periodically
 *
 * Usage: BIRDEYE_API_KEY=... npx ts-node clients/risk-service/index.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../../target/types/lh_core";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const UPDATE_INTERVAL_MS = parseInt(process.env.RISK_UPDATE_INTERVAL_MS || "600000", 10);
const STRESS_THRESHOLD = 1.5;
const CARRY_BPS_PER_DAY = parseInt(process.env.CARRY_BPS_PER_DAY || "10", 10);
const MAX_RETRIES = 3;

// ─── State ───────────────────────────────────────────────────────────

let lastSuccessTs: Date | null = null;
let consecutiveFailures = 0;
let cycleCount = 0;
let lastSigmaPpm = 200_000;
let lastSigmaMaPpm = 180_000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ─── Types ───────────────────────────────────────────────────────────

interface OHLCVCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  unixTime: number;
}

// ─── Birdeye Integration ─────────────────────────────────────────────

async function fetchOHLCVWithRetry(apiKey: string, days: number = 30): Promise<OHLCVCandle[]> {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;
  const url = `https://public-api.birdeye.so/defi/ohlcv?address=${SOL_MINT}&type=15m&time_from=${from}&time_to=${now}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
      });
      if (!resp.ok) {
        throw new Error(`Birdeye API error: ${resp.status} ${resp.statusText}`);
      }
      const data = (await resp.json()) as any;
      return data.data?.items || [];
    } catch (err) {
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      if (attempt < MAX_RETRIES) {
        log("WARN", `Birdeye fetch failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${err}`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  return []; // unreachable
}

// ─── Volatility Computation ──────────────────────────────────────────

function computeVolatility(candles: OHLCVCandle[]): {
  sigmaPpm: number;
  sigmaMaPpm: number;
} {
  if (candles.length < 10) {
    return { sigmaPpm: 200_000, sigmaMaPpm: 200_000 }; // fallback 20%
  }

  const closes = candles.map((c) => c.c);
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  if (logReturns.length < 5) {
    return { sigmaPpm: 200_000, sigmaMaPpm: 200_000 };
  }

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize: 15-min candles -> 35040 per year
  const periodsPerYear = 4 * 24 * 365;
  const annualizedVol = stdDev * Math.sqrt(periodsPerYear);
  const sigmaPpm = Math.round(annualizedVol * 1_000_000);

  // 7-day moving average
  const recentCandles = candles.slice(-672);
  const recentCloses = recentCandles.map((c) => c.c);
  const recentReturns: number[] = [];
  for (let i = 1; i < recentCloses.length; i++) {
    if (recentCloses[i] > 0 && recentCloses[i - 1] > 0) {
      recentReturns.push(Math.log(recentCloses[i] / recentCloses[i - 1]));
    }
  }
  const rMean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  const rVar =
    recentReturns.reduce((a, b) => a + (b - rMean) ** 2, 0) / (recentReturns.length - 1);
  const rStdDev = Math.sqrt(rVar);
  const sigmaMaPpm = Math.round(rStdDev * Math.sqrt(periodsPerYear) * 1_000_000);

  return {
    sigmaPpm: clampSigma(sigmaPpm),
    sigmaMaPpm: clampSigma(sigmaMaPpm || sigmaPpm),
  };
}

/** Clamp sigma to on-chain accepted range [1_000, 5_000_000] PPM */
function clampSigma(ppm: number): number {
  return Math.max(1_000, Math.min(5_000_000, ppm));
}

// ─── On-chain Publishing ─────────────────────────────────────────────

async function publishSnapshot(
  program: Program<LhCore>,
  admin: PublicKey,
  sigmaPpm: number,
  sigmaMaPpm: number,
  stressFlag: boolean,
  carryBpsPerDay: number
) {
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool")],
    program.programId
  );
  const [regimePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("regime"), poolState.toBuffer()],
    program.programId
  );

  await program.methods
    .updateRegimeSnapshot(
      new anchor.BN(sigmaPpm),
      new anchor.BN(sigmaMaPpm),
      stressFlag,
      carryBpsPerDay
    )
    .accountsPartial({
      authority: admin,
      poolState,
      regimeSnapshot: regimePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

// ─── Main Loop ───────────────────────────────────────────────────────

async function runOnce(program: Program<LhCore>, admin: PublicKey) {
  cycleCount++;
  const apiKey = process.env.BIRDEYE_API_KEY;

  let sigmaPpm: number;
  let sigmaMaPpm: number;

  try {
    if (apiKey) {
      log("INFO", "Fetching Birdeye OHLCV...");
      const candles = await fetchOHLCVWithRetry(apiKey);
      log("INFO", `Got ${candles.length} candles`);
      const vol = computeVolatility(candles);
      sigmaPpm = vol.sigmaPpm;
      sigmaMaPpm = vol.sigmaMaPpm;
    } else {
      log("INFO", "No BIRDEYE_API_KEY — using mock volatility (20%)");
      sigmaPpm = 200_000;
      sigmaMaPpm = 180_000;
    }

    // Update cached values on success
    lastSigmaPpm = sigmaPpm;
    lastSigmaMaPpm = sigmaMaPpm;
  } catch (err) {
    consecutiveFailures++;
    log("ERROR", `Data fetch failed (${consecutiveFailures} consecutive): ${err}`);
    log("WARN", `Using cached values: sigma=${lastSigmaPpm}, sigma_ma=${lastSigmaMaPpm}`);
    sigmaPpm = lastSigmaPpm;
    sigmaMaPpm = lastSigmaMaPpm;

    // Don't publish stale data if we've failed too many times
    if (consecutiveFailures > 5) {
      log("ERROR", "Too many consecutive failures, skipping snapshot publish");
      return;
    }
  }

  const stressFlag = sigmaMaPpm > 0 ? sigmaPpm / sigmaMaPpm > STRESS_THRESHOLD : false;

  log(
    "INFO",
    `Cycle #${cycleCount}: sigma=${(sigmaPpm / 10_000).toFixed(2)}%, ` +
    `sigma_ma=${(sigmaMaPpm / 10_000).toFixed(2)}%, ` +
    `stress=${stressFlag}, carry=${CARRY_BPS_PER_DAY}bps/day`
  );

  try {
    await publishSnapshot(program, admin, sigmaPpm, sigmaMaPpm, stressFlag, CARRY_BPS_PER_DAY);
    lastSuccessTs = new Date();
    consecutiveFailures = 0;
    log("INFO", "RegimeSnapshot published on-chain");
  } catch (err) {
    consecutiveFailures++;
    log("ERROR", `Publish failed: ${err}`);
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

// ─── Logging ─────────────────────────────────────────────────────────

function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  const lastSuccess = lastSuccessTs ? lastSuccessTs.toISOString() : "never";
  console.log(`[${ts}] [risk-service] [${level}] ${msg} (lastSuccess=${lastSuccess})`);
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
  const admin = provider.wallet.publicKey;

  log("INFO", "Starting...");
  log("INFO", `Program: ${program.programId.toBase58()}`);
  log("INFO", `Update interval: ${UPDATE_INTERVAL_MS / 1000}s`);
  log("INFO", `Carry: ${CARRY_BPS_PER_DAY} bps/day`);

  await runOnce(program, admin);

  if (process.env.ONCE !== "true") {
    intervalHandle = setInterval(
      () => runOnce(program, admin).catch((e) => log("ERROR", `Unhandled: ${e}`)),
      UPDATE_INTERVAL_MS
    );
  }
}

main().catch((e) => {
  log("ERROR", `Fatal: ${e}`);
  process.exit(1);
});
