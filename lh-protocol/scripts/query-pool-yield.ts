#!/usr/bin/env ts-node
/**
 * query-pool-yield.ts — live empirical readout of the fee-yield stack.
 *
 * Answers the question the paper raises when it retires the hardcoded
 * `PoolState.expectedDailyFee = 0.5%/day` constant: what does the
 * Birdeye + GBM adapter actually produce at different range widths?
 *
 * Workflow:
 *   1. Fetch pool overview (TVL, 24h volume, 7d volume, fee tier) from
 *      Birdeye `/defi/v3/pair/overview/single` for the SOL/USDC 0.04%
 *      Whirlpool.
 *   2. Fetch daily OHLCV and derive σ (30-day annualized) via the same
 *      Birdeye adapter used in live-orca-test.ts — no hardcoded σ.
 *   3. Compute pool-level yield (24h window and 7d-average window).
 *   4. Compute the width-sensitive in-range fraction and composite
 *      position-level yield for ±5%, ±7.5%, ±10% ranges at tenor 7 d.
 *   5. Print a human-readable table.
 *
 * Requires BIRDEYE_API_KEY. Optional: WHIRLPOOL_ADDRESS (default mainnet
 * SOL/USDC), TENOR_DAYS (default 7).
 *
 * Usage:
 *   BIRDEYE_API_KEY=... npx ts-node scripts/query-pool-yield.ts
 */

import "dotenv/config";

import {
  fetchPoolOverview,
  estimatePoolDailyYield,
  estimatePositionDailyYield,
} from "../protocol-src/market-data/orca-volume-adapter";
import {
  fetchOHLCV,
  computeVolatility,
} from "../protocol-src/market-data/birdeye-adapter";
import { MAINNET_WHIRLPOOL } from "../protocol-src/config/chain";
import { PPM } from "../protocol-src/types";

const WIDTH_GRID_BPS = [500, 750, 1000]; // ±5%, ±7.5%, ±10%

/** Orca SOL/USDC mainnet Whirlpool fee tier (tick spacing 64). */
const DEFAULT_FEE_TIER = 0.0004;

function pct(x: number, digits: number = 4): string {
  return (x * 100).toFixed(digits) + "%";
}

function fmtUsd(x: number): string {
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  return `$${x.toFixed(2)}`;
}

async function main(): Promise<void> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    console.error("ERROR: BIRDEYE_API_KEY is required.");
    process.exit(1);
  }

  const poolAddress =
    process.env.WHIRLPOOL_ADDRESS ?? MAINNET_WHIRLPOOL.toBase58();
  const feeTier = Number(process.env.FEE_TIER ?? DEFAULT_FEE_TIER);
  const tenorDays = Number(process.env.TENOR_DAYS ?? 7);
  const tenorSeconds = tenorDays * 86_400;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Liquidity Hedge — live pool-yield readout");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Pool:          ${poolAddress}`);
  console.log(`Tenor:         ${tenorDays} days`);
  console.log("");

  // ── 1. Pool overview (TVL, volume, fee tier) ──────────────────────
  console.log("[1/3] Fetching pool overview from Birdeye …");
  const overview = await fetchPoolOverview(apiKey, poolAddress, feeTier);
  console.log(`       TVL:          ${fmtUsd(overview.liquidityUsd)}`);
  console.log(`       Vol 24h:      ${fmtUsd(overview.volume24hUsd)}`);
  console.log(`       Fee tier:     ${pct(overview.feeTier, 3)}  (from FEE_TIER env / default)`);
  console.log(`       Price:        ${fmtUsd(overview.priceUsd)}`);
  console.log("");

  // ── 2. Realized volatility from same Birdeye adapter ──────────────
  console.log("[2/3] Computing σ from 30-day daily OHLCV …");
  const candles = await fetchOHLCV(apiKey, 30, "1D");
  const vol = computeVolatility(candles, "1D");
  const sigma = vol.sigmaPpm / PPM;
  const sigma7d = vol.sigma7dPpm / PPM;
  console.log(`       σ_30d:        ${pct(sigma, 2)}`);
  console.log(`       σ_7d:         ${pct(sigma7d, 2)}`);
  console.log(`       stressFlag:   ${vol.stressFlag}`);
  console.log("");

  // ── 3. Pool-level yield (24h — Birdeye v3 doesn't expose 7d) ──────
  const r_pool_24h = estimatePoolDailyYield(overview, "24h");
  console.log("[3/3] Pool-level yield (uniform-liquidity benchmark):");
  console.log(
    `       r_pool (24h window):    ${pct(r_pool_24h)}/day  (${pct(r_pool_24h * 365, 2)} APR)`,
  );
  console.log("");

  // ── 4. Width-sensitive position yield ─────────────────────────────
  console.log("Position-level yield by range width (σ_30d, tenor-avg GBM):");
  console.log("");
  console.log(
    "   width        inRangeFrac   r_position/day   r_position APR",
  );
  console.log(
    "   ─────────    ───────────   ──────────────   ──────────────",
  );
  for (const widthBps of WIDTH_GRID_BPS) {
    const est = estimatePositionDailyYield(
      overview,
      widthBps,
      sigma,
      tenorSeconds,
      1, // concentrationFactor = 1 (honest lower bound)
      "24h",
    );
    const widthPct = (widthBps / 100).toFixed(1);
    console.log(
      `   ±${widthPct.padStart(5)}%    ` +
        `${est.inRangeFraction.toFixed(4).padStart(11)}   ` +
        `${pct(est.positionDailyYield).padStart(14)}   ` +
        `${pct(est.positionDailyYield * 365, 2).padStart(14)}`,
    );
  }
  console.log("");
  console.log("Notes:");
  console.log("  • r_pool = vol_24h × fee_tier / TVL (uniform LP benchmark)");
  console.log(
    "  • inRangeFraction = (1/T) ∫_0^T P(S_t ∈ [p_l, p_u]) dt, GBM with σ above",
  );
  console.log(
    "  • r_position = r_pool × inRangeFraction × concentrationFactor (=1)",
  );
  console.log(
    "  • concentrationFactor=1 is a lower bound — a narrow-range LP earns",
  );
  console.log(
    "    a disproportionate share of in-range fees; measuring it requires",
  );
  console.log("    per-tick pool liquidity (orthogonal upgrade).");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("query-pool-yield failed:", err);
  process.exit(1);
});
