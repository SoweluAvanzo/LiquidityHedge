/**
 * Pool fee-growth snapshots (Tier C, exact-going-forward yield history).
 *
 * One record per pool per tick captures the chain's OWN fee ledger:
 * feeGrowthGlobal (cumulative fees per unit of liquidity, Q64.64) plus
 * price and active liquidity. From these, the exact fee income of ANY
 * position — real or hypothetical — in that pool is a pure computation:
 *
 *   fees(range, L) = Σ over intervals where price ∈ range:
 *                      ΔfeeGrowthGlobal × L / 2^64
 *
 * No position-specific data is required: per-unit-of-liquidity accounting
 * means the competing-liquidity division is already baked in.
 *
 * Documented approximations:
 *  - boundary-crossing intervals are weighted ½ (error bounded by the
 *    snapshot cadence);
 *  - the counterfactual is exact for MARGINAL positions; for a large
 *    hypothetical L, apply the optional dilution factor
 *    L_active/(L_active+L) from the recorded liquidity.
 */

import * as fs from "fs";
import * as path from "path";

const Q64 = 1n << 64n;
const U128 = 1n << 128n;

export interface PoolSnapshot {
  /** Unix seconds at capture. */
  t: number;
  /** Human price (token B per token A, decimal-adjusted). */
  price: number;
  /** Active liquidity at the current tick (u128, stringified). */
  liquidity: string;
  /** Cumulative fee growth per unit L, token A (Q64.64 u128, stringified). */
  feeGrowthGlobalA: string;
  /** Same for token B. */
  feeGrowthGlobalB: string;
  /** Pool vault balance, token A native units (u64, stringified).
   *  Optional: absent in snapshots taken before TVL capture existed. */
  vaultA?: string;
  /** Pool vault balance, token B native units. */
  vaultB?: string;
}

/**
 * Exact on-chain TVL at a snapshot, denominated in TOKEN B (the quote
 * token): vaultB + vaultA × price. Independent of any market-data vendor.
 *
 * This is USD only when token B is a USD stablecoin — for e.g. SOL/JitoSOL
 * the result is in JitoSOL. Callers that aggregate across pools MUST check
 * the quote token (see `isUsdQuote`) or they will sum incommensurable units.
 * Returns null for snapshots taken before vault capture existed.
 */
export function snapshotTvlQuote(
  snapshot: PoolSnapshot,
  decimalsA: number,
  decimalsB: number,
): number | null {
  if (snapshot.vaultA === undefined || snapshot.vaultB === undefined) return null;
  return (
    (Number(BigInt(snapshot.vaultA)) / 10 ** decimalsA) * snapshot.price +
    Number(BigInt(snapshot.vaultB)) / 10 ** decimalsB
  );
}

/** USD-pegged quote mints — the only pools whose quote-denominated TVL is USD. */
export const USD_QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", //  USDS
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
]);

export function isUsdQuote(quoteMint: string): boolean {
  return USD_QUOTE_MINTS.has(quoteMint);
}

/** Wrap-safe delta in mod-2^128 arithmetic (feeGrowth counters wrap). */
export function feeGrowthDelta(later: bigint, earlier: bigint): bigint {
  return (later - earlier + U128) % U128;
}

export interface RangeYieldResult {
  /** Exact fees the range would have earned, native token-A units. */
  feesA: bigint;
  /** Native token-B units (µUSDC for USDC pools). */
  feesB: bigint;
  /** Seconds weighted in range (full + half-weighted crossings). */
  inRangeSeconds: number;
  totalSeconds: number;
  intervals: number;
  /** Intervals weighted ½ because the price crossed a range boundary. */
  crossings: number;
}

export function computeRangeFeeYield(
  snapshots: PoolSnapshot[],
  priceLower: number,
  priceUpper: number,
  liquidity: bigint,
  opts?: {
    /** Apply marginal-dilution adjustment using recorded active liquidity. */
    adjustForDilution?: boolean;
  },
): RangeYieldResult {
  if (snapshots.length < 2) {
    return { feesA: 0n, feesB: 0n, inRangeSeconds: 0, totalSeconds: 0, intervals: 0, crossings: 0 };
  }
  if (!(priceUpper > priceLower)) {
    throw new Error(`invalid range [${priceLower}, ${priceUpper}]`);
  }
  const inRange = (p: number) => p >= priceLower && p <= priceUpper;

  let feesA = 0n;
  let feesB = 0n;
  let inRangeSeconds = 0;
  let crossings = 0;
  let totalSeconds = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1];
    const b = snapshots[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    totalSeconds += dt;

    const inA = inRange(a.price);
    const inB = inRange(b.price);
    // weight 1: fully in range; 0: fully out (same side); ½: crossing.
    let weightNum = 0n;
    let weightDen = 1n;
    if (inA && inB) {
      weightNum = 1n;
    } else if (inA !== inB || (a.price < priceLower) !== (b.price < priceLower)) {
      weightNum = 1n;
      weightDen = 2n;
      crossings++;
    }
    if (weightNum === 0n) continue;

    let effL = liquidity;
    if (opts?.adjustForDilution) {
      const active = BigInt(a.liquidity);
      if (active + liquidity > 0n) {
        effL = (liquidity * active) / (active + liquidity);
      }
    }

    const dA = feeGrowthDelta(BigInt(b.feeGrowthGlobalA), BigInt(a.feeGrowthGlobalA));
    const dB = feeGrowthDelta(BigInt(b.feeGrowthGlobalB), BigInt(a.feeGrowthGlobalB));
    feesA += (dA * effL * weightNum) / weightDen / Q64;
    feesB += (dB * effL * weightNum) / weightDen / Q64;
    inRangeSeconds += weightDen === 2n ? dt / 2 : dt;
  }

  return {
    feesA,
    feesB,
    inRangeSeconds,
    totalSeconds,
    intervals: snapshots.length - 1,
    crossings,
  };
}

// ── Direct pool-yield measurement (remediation plan §1.1) ─────────────
//
// Replaces the vendor-modelled r_pool = volume₂₄ₕ × feeTier / TVL with a
// measurement from the chain's own fee ledger. Per snapshot interval:
//
//   LP fees paid = Δ feeGrowthGlobal × L_active / 2⁶⁴   (per token)
//
// valued at the interval's price, divided by the interval's vault-derived
// TVL. The protocol's fee share never appears because feeGrowthGlobal is
// incremented NET of it — the correction is inside the accumulator, not a
// modelling step.

export interface MeasuredPoolYield {
  /** LP fee yield per unit of TVL per DAY, averaged over covered time. */
  dailyYield: number;
  /** Wall-clock span from first to last snapshot considered. */
  windowSeconds: number;
  /** Seconds actually integrated (gaps and unusable intervals excluded). */
  coveredSeconds: number;
  /** Intervals integrated. */
  intervals: number;
  /** Intervals skipped: longer than maxGapSeconds (collector outage). */
  gapIntervals: number;
  /** Intervals skipped: no vault balances (pre-TVL-capture snapshots). */
  noTvlIntervals: number;
  /** Intervals skipped: fee delta implausible for the elapsed time
   *  (wrapped or reset accumulator — never silently included). */
  implausibleIntervals: number;
  /** Total LP fees over covered time, quote units (USD for USDC pools). */
  feesQuote: number;
  /** Time-weighted TVL over covered time, quote units. */
  avgTvlQuote: number;
  firstT: number;
  lastT: number;
}

/** An interval yielding more than this fraction of TVL is a broken
 *  accumulator (reset/wrap), not fees — 50% of TVL between snapshots. */
const IMPLAUSIBLE_INTERVAL_YIELD = 0.5;

/**
 * Measured pool-average daily fee yield from fee-growth snapshots.
 *
 * Approximation note: Δgrowth × L_active(start) equals fees paid only
 * while L_active is constant within the interval; the error is bounded
 * by the snapshot cadence and L variation, the same first-order status
 * as `computeRangeFeeYield`. Returns null when not a single interval is
 * usable — the caller falls back to the modelled estimate and says so.
 */
export function measurePoolDailyYield(
  snapshots: PoolSnapshot[],
  decimalsA: number,
  decimalsB: number,
  opts?: { maxGapSeconds?: number },
): MeasuredPoolYield | null {
  if (snapshots.length < 2) return null;
  const maxGap = opts?.maxGapSeconds ?? 3600;

  let sumRate = 0;
  let covered = 0;
  let feesQuote = 0;
  let tvlSeconds = 0;
  let intervals = 0;
  let gapIntervals = 0;
  let noTvlIntervals = 0;
  let implausibleIntervals = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1];
    const b = snapshots[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    if (dt > maxGap) {
      gapIntervals++;
      continue;
    }
    const tvlA = snapshotTvlQuote(a, decimalsA, decimalsB);
    const tvlB = snapshotTvlQuote(b, decimalsA, decimalsB);
    if (tvlA === null || tvlB === null || tvlA <= 0 || tvlB <= 0) {
      noTvlIntervals++;
      continue;
    }
    const tvlMid = (tvlA + tvlB) / 2;

    const L = BigInt(a.liquidity);
    const dA = feeGrowthDelta(BigInt(b.feeGrowthGlobalA), BigInt(a.feeGrowthGlobalA));
    const dB = feeGrowthDelta(BigInt(b.feeGrowthGlobalB), BigInt(a.feeGrowthGlobalB));
    const feesA = Number((dA * L) / Q64) / 10 ** decimalsA;
    const feesB = Number((dB * L) / Q64) / 10 ** decimalsB;
    const priceMid = (a.price + b.price) / 2;
    const fees = feesA * priceMid + feesB;

    const rate = fees / tvlMid;
    if (!Number.isFinite(rate) || rate < 0 || rate > IMPLAUSIBLE_INTERVAL_YIELD) {
      implausibleIntervals++;
      continue;
    }

    sumRate += rate;
    feesQuote += fees;
    covered += dt;
    tvlSeconds += tvlMid * dt;
    intervals++;
  }

  if (intervals === 0 || covered <= 0) return null;
  return {
    dailyYield: sumRate / (covered / 86_400),
    windowSeconds: snapshots[snapshots.length - 1].t - snapshots[0].t,
    coveredSeconds: covered,
    intervals,
    gapIntervals,
    noTvlIntervals,
    implausibleIntervals,
    feesQuote,
    avgTvlQuote: tvlSeconds / covered,
    firstT: snapshots[0].t,
    lastT: snapshots[snapshots.length - 1].t,
  };
}

/** Convert a yield result to USD using an average accrual price. */
export function rangeYieldUsd(
  result: RangeYieldResult,
  avgPriceUsd: number,
  decimalsA: number,
  decimalsB: number,
): number {
  return (
    (Number(result.feesA) / 10 ** decimalsA) * avgPriceUsd +
    Number(result.feesB) / 10 ** decimalsB
  );
}

// ── Storage (same file-backed pattern as FileCandleStore; Postgres
//    adapter later behind the same interface) ─────────────────────────

export interface PoolSnapshotStore {
  append(poolAddress: string, snapshot: PoolSnapshot): Promise<void>;
  read(poolAddress: string, timeFrom: number, timeTo: number): Promise<PoolSnapshot[]>;
  latest(poolAddress: string): Promise<PoolSnapshot | null>;
}

export class FilePoolSnapshotStore implements PoolSnapshotStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(poolAddress: string): string {
    return path.join(this.dir, `${poolAddress}.snapshots.jsonl`);
  }

  async append(poolAddress: string, snapshot: PoolSnapshot): Promise<void> {
    fs.appendFileSync(this.file(poolAddress), JSON.stringify(snapshot) + "\n");
  }

  private load(poolAddress: string): PoolSnapshot[] {
    const f = this.file(poolAddress);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as PoolSnapshot)
      .sort((a, b) => a.t - b.t);
  }

  async read(poolAddress: string, timeFrom: number, timeTo: number): Promise<PoolSnapshot[]> {
    return this.load(poolAddress).filter((s) => s.t >= timeFrom && s.t <= timeTo);
  }

  async latest(poolAddress: string): Promise<PoolSnapshot | null> {
    const all = this.load(poolAddress);
    return all.length > 0 ? all[all.length - 1] : null;
  }
}
