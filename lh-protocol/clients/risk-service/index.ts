/**
 * Risk Service — fetches market data, computes volatility, publishes RegimeSnapshot.
 *
 * For the PoC, this uses a simplified volatility model:
 * - Fetch SOL/USDC price history from Birdeye (or mock data)
 * - Compute realized volatility from log returns
 * - Compute moving average of sigma
 * - Determine stress flag (sigma/sigma_ma > threshold)
 * - Publish RegimeSnapshot on-chain every 10 minutes
 *
 * Usage: BIRDEYE_API_KEY=... npx ts-node clients/risk-service/index.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LhCore } from "../../target/types/lh_core";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STRESS_THRESHOLD = 1.5; // sigma/sigma_ma > 1.5 triggers stress
const CARRY_BPS_PER_DAY = 10; // conservative constant for PoC

interface OHLCVCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  unixTime: number;
}

/** Fetch SOL/USDC OHLCV from Birdeye */
async function fetchOHLCV(apiKey: string, days: number = 30): Promise<OHLCVCandle[]> {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;

  const url = `https://public-api.birdeye.so/defi/ohlcv?address=${SOL_MINT}&type=15m&time_from=${from}&time_to=${now}`;
  const resp = await fetch(url, {
    headers: {
      "X-API-KEY": apiKey,
      "x-chain": "solana",
    },
  });

  if (!resp.ok) {
    throw new Error(`Birdeye API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  return data.data?.items || [];
}

/** Compute annualized realized volatility from close prices */
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

  // Standard deviation of log returns
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize: 15-min candles → 4 per hour × 24 hours × 365 days = 35040 per year
  const periodsPerYear = 4 * 24 * 365;
  const annualizedVol = stdDev * Math.sqrt(periodsPerYear);

  // Convert to PPM (parts per million)
  const sigmaPpm = Math.round(annualizedVol * 1_000_000);

  // Simple moving average: use last 7 days of candles for MA
  const recentCandles = candles.slice(-672); // 7 days × 96 candles/day
  // Avoid recursion - compute MA separately
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

  return { sigmaPpm, sigmaMaPpm: sigmaMaPpm || sigmaPpm };
}

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

async function runOnce(program: Program<LhCore>, admin: PublicKey) {
  const apiKey = process.env.BIRDEYE_API_KEY;

  let sigmaPpm: number;
  let sigmaMaPpm: number;

  if (apiKey) {
    console.log("Fetching Birdeye OHLCV...");
    const candles = await fetchOHLCV(apiKey);
    console.log(`  Got ${candles.length} candles`);
    const vol = computeVolatility(candles);
    sigmaPpm = vol.sigmaPpm;
    sigmaMaPpm = vol.sigmaMaPpm;
  } else {
    console.log("No BIRDEYE_API_KEY — using mock volatility (20%)");
    sigmaPpm = 200_000;
    sigmaMaPpm = 180_000;
  }

  const stressFlag = sigmaMaPpm > 0 ? sigmaPpm / sigmaMaPpm > STRESS_THRESHOLD : false;

  console.log(
    `  σ=${(sigmaPpm / 10_000).toFixed(2)}%, ` +
    `σ_ma=${(sigmaMaPpm / 10_000).toFixed(2)}%, ` +
    `stress=${stressFlag}`
  );

  await publishSnapshot(program, admin, sigmaPpm, sigmaMaPpm, stressFlag, CARRY_BPS_PER_DAY);
  console.log("  RegimeSnapshot published on-chain");
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LhCore as Program<LhCore>;
  const admin = provider.wallet.publicKey;

  console.log("Risk Service starting...");
  console.log(`  Program: ${program.programId.toBase58()}`);
  console.log(`  Update interval: ${UPDATE_INTERVAL_MS / 1000}s`);

  // Run once immediately
  await runOnce(program, admin);

  // Loop
  if (process.env.ONCE !== "true") {
    setInterval(() => runOnce(program, admin).catch(console.error), UPDATE_INTERVAL_MS);
  }
}

main().catch(console.error);
