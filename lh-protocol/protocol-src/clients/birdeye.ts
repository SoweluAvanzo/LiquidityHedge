/**
 * Birdeye API Client — Real OHLCV Data for SOL/USDC
 *
 * Fetches historical price candles and computes realized volatility.
 * Used by the simulation script for real-data backtesting and by
 * the risk service for live regime snapshot updates.
 *
 * API endpoint: https://public-api.birdeye.so/defi/ohlcv
 * Authentication: X-API-KEY header
 */

import { PPM } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OHLCVCandle {
  o: number;    // open
  h: number;    // high
  l: number;    // low
  c: number;    // close
  v: number;    // volume
  unixTime: number;
}

export interface VolatilityResult {
  /** 30-day annualized realized vol (PPM) */
  sigmaPpm: number;
  /** 7-day annualized realized vol (PPM) */
  sigma7dPpm: number;
  /** Stress flag: sigma7d > 1.5 * sigma30d */
  stressFlag: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so/defi/ohlcv";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Annualization factor for 15-minute candles: √(4 * 24 * 365) */
const ANNUALIZATION_15M = Math.sqrt(4 * 24 * 365); // ≈ 187.08

/** Annualization factor for daily candles: √365 */
const ANNUALIZATION_1D = Math.sqrt(365);

const STRESS_THRESHOLD = 1.5;

// ---------------------------------------------------------------------------
// Fetch OHLCV candles
// ---------------------------------------------------------------------------

/**
 * Fetch OHLCV candles from Birdeye for SOL/USDC.
 *
 * @param apiKey    - Birdeye API key
 * @param days      - Number of days of history (default 60 for weekly prices)
 * @param timeframe - Candle timeframe: "15m", "1H", "1D" (default "1D")
 * @param retries   - Number of retry attempts (default 3)
 * @returns Array of OHLCV candles sorted by time ascending
 */
export async function fetchOHLCV(
  apiKey: string,
  days: number = 60,
  timeframe: string = "1D",
  retries: number = 3,
): Promise<OHLCVCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86_400;

  const url =
    `${BIRDEYE_BASE_URL}?address=${SOL_MINT}` +
    `&type=${timeframe}` +
    `&time_from=${from}` +
    `&time_to=${now}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": "solana",
        },
      });

      if (!resp.ok) {
        throw new Error(`Birdeye API error: ${resp.status} ${resp.statusText}`);
      }

      const json = await resp.json() as any;
      if (!json.success || !json.data?.items) {
        throw new Error(`Birdeye response missing data: ${JSON.stringify(json).slice(0, 200)}`);
      }

      const candles: OHLCVCandle[] = json.data.items.map((item: any) => ({
        o: item.o,
        h: item.h,
        l: item.l,
        c: item.c,
        v: item.v ?? 0,
        unixTime: item.unixTime,
      }));

      // Sort ascending by time
      candles.sort((a, b) => a.unixTime - b.unixTime);
      return candles;
    } catch (err) {
      console.error(`Birdeye fetch attempt ${attempt}/${retries} failed:`, (err as Error).message);
      if (attempt < retries) {
        await sleep(2000 * Math.pow(2, attempt - 1));
      }
    }
  }

  console.warn("All Birdeye fetch attempts failed, returning empty array");
  return [];
}

/**
 * Fetch weekly closing prices for backtesting.
 *
 * Returns an array of {price, timestamp} for each week in the period.
 * Uses daily candles and samples every 7th close.
 *
 * @param apiKey - Birdeye API key
 * @param weeks  - Number of weeks of history (default 52)
 * @returns Array of weekly price points
 */
export async function fetchWeeklyPrices(
  apiKey: string,
  weeks: number = 52,
): Promise<{ price: number; timestamp: number }[]> {
  const days = weeks * 7 + 7; // Extra week for first entry price
  const candles = await fetchOHLCV(apiKey, days, "1D");

  if (candles.length < 14) {
    throw new Error(`Insufficient data: got ${candles.length} candles, need at least 14`);
  }

  // Sample every 7th candle's close price
  const weeklyPrices: { price: number; timestamp: number }[] = [];
  for (let i = 0; i < candles.length; i += 7) {
    weeklyPrices.push({
      price: candles[i].c,
      timestamp: candles[i].unixTime,
    });
  }

  return weeklyPrices;
}

// ---------------------------------------------------------------------------
// Volatility computation
// ---------------------------------------------------------------------------

/**
 * Compute realized volatility from OHLCV candles.
 *
 * Algorithm:
 *   1. Compute log returns: r_i = ln(close_i / close_{i-1})
 *   2. Full-period std → annualize by √(periods_per_year)
 *   3. Last 7 days subset → annualize (short-term vol)
 *   4. Stress flag: short-term > 1.5 × full-period
 *
 * @param candles   - OHLCV candles (ascending time order)
 * @param timeframe - "15m" | "1H" | "1D" for annualization factor
 * @returns Volatility result with sigma, sigma7d, and stress flag
 */
export function computeVolatility(
  candles: OHLCVCandle[],
  timeframe: string = "1D",
): VolatilityResult {
  if (candles.length < 3) {
    return { sigmaPpm: 200_000, sigma7dPpm: 200_000, stressFlag: false };
  }

  // Compute log returns
  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > 0 && candles[i - 1].c > 0) {
      logReturns.push(Math.log(candles[i].c / candles[i - 1].c));
    }
  }

  if (logReturns.length < 2) {
    return { sigmaPpm: 200_000, sigma7dPpm: 200_000, stressFlag: false };
  }

  // Annualization factor
  let annFactor: number;
  switch (timeframe) {
    case "15m":
      annFactor = ANNUALIZATION_15M;
      break;
    case "1H":
      annFactor = Math.sqrt(24 * 365);
      break;
    case "1D":
    default:
      annFactor = ANNUALIZATION_1D;
  }

  // Full-period volatility
  const sigma = stdDev(logReturns) * annFactor;
  const sigmaPpm = clampSigma(Math.round(sigma * PPM));

  // 7-day vol (last N candles depending on timeframe)
  let shortPeriodCandles: number;
  switch (timeframe) {
    case "15m":
      shortPeriodCandles = 7 * 4 * 24; // 672
      break;
    case "1H":
      shortPeriodCandles = 7 * 24; // 168
      break;
    case "1D":
    default:
      shortPeriodCandles = 7;
  }

  const recentReturns =
    logReturns.length > shortPeriodCandles
      ? logReturns.slice(-shortPeriodCandles)
      : logReturns;
  const sigma7d = stdDev(recentReturns) * annFactor;
  const sigma7dPpm = clampSigma(Math.round(sigma7d * PPM));

  const stressFlag = sigmaPpm > 0 ? sigma7dPpm / sigmaPpm > STRESS_THRESHOLD : false;

  return { sigmaPpm, sigma7dPpm, stressFlag };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function clampSigma(ppm: number): number {
  return Math.max(1_000, Math.min(5_000_000, ppm));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
