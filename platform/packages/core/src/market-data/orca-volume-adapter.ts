/**
 * Orca pool-volume fee-yield adapter.
 *
 * Replaces the hardcoded `PoolState.expectedDailyFee = 0.5%/day`
 * governance constant with a measurement-driven estimate.
 *
 * The estimate is layered:
 *
 *   1. `estimatePoolDailyYield` — pool-average fee yield per dollar of
 *      pooled capital per day, measured directly from Birdeye:
 *
 *          r_pool = volume_24h × fee_tier / TVL
 *
 *      This is honest for a uniform-liquidity LP but ignores both
 *      range width and time-in-range.
 *
 *   2. `inRangeFraction` — expected fraction of the tenor during which
 *      `S_t ∈ [p_l, p_u]`, computed from GBM + realized volatility σ
 *      via numerical integration. A narrow range spends less time
 *      earning fees.
 *
 *   3. `estimatePositionDailyYield` — composite:
 *
 *          r_position = r_pool × inRangeFraction × concentrationFactor
 *
 *      where `concentrationFactor` defaults to 1 (honest lower bound
 *      corresponding to "our LP's share of in-range fees matches the
 *      pool-average density"). Measuring the true concentration factor
 *      would require per-tick pool liquidity data (Orca tick-array
 *      accounts); that upgrade is orthogonal to this file.
 *
 * What this does and does not deliver:
 *   ✓ Pool-level volume and TVL from Birdeye (measurement, not guess)
 *   ✓ Time-in-range adjustment for range width (GBM + σ)
 *   ✗ Concentration multiplier (requires tick-level data)
 *
 * The two missing factors mean narrow-range positions are
 * systematically *under-estimated* in fee income by this adapter —
 * which is the conservative direction for the LP (over-estimates
 * premium rather than under-estimates it).
 */

import { SECONDS_PER_YEAR } from "../types";

// ---------------------------------------------------------------------------
// Birdeye pair-overview client
// ---------------------------------------------------------------------------

export interface PoolOverview {
  address: string;
  tokenMintA: string;
  tokenMintB: string;
  liquidityUsd: number;
  volume24hUsd: number;
  volume7dUsd: number;
  feeTier: number; // e.g. 0.0004 for a 0.04% pool
  priceUsd: number;
  fetchedAt: Date;
}

const BIRDEYE_BASE = "https://public-api.birdeye.so";

/**
 * Fetch pool overview from Birdeye.
 *
 * Uses `/defi/v3/pair/overview/single` which returns TVL, price, and
 * multi-horizon volume windows (30m, 1h, 2h, 4h, 8h, 12h, 24h). The
 * endpoint does NOT expose `fee_rate` (it's an on-chain field, not a
 * market data field) nor a `volume_7d` — callers who need 7d volume
 * should aggregate from an OHLCV query.
 *
 * @param apiKey      - Birdeye API key (free tier is enough for read-only overview queries)
 * @param poolAddress - pool address on Solana (for Orca SOL/USDC 0.04%: Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE)
 * @param feeTier     - pool fee tier as a decimal (e.g. 0.0004 for the 0.04% Whirlpool).
 *                      Read from the on-chain `Whirlpool.fee_rate` field; not in the Birdeye response.
 * @param volume7dUsd - optional 7d USD volume if the caller has it from another source (OHLCV
 *                      aggregation, a dashboard, etc.). Defaults to 0, in which case
 *                      `estimatePoolDailyYield(stats, "7d")` returns 0.
 */
export async function fetchPoolOverview(
  apiKey: string,
  poolAddress: string,
  feeTier: number,
  volume7dUsd: number = 0,
): Promise<PoolOverview> {
  if (!apiKey) {
    throw new Error("BIRDEYE_API_KEY is required for fetchPoolOverview");
  }
  const url = `${BIRDEYE_BASE}/defi/v3/pair/overview/single?address=${poolAddress}`;
  const resp = await fetch(url, {
    headers: {
      "X-API-KEY": apiKey,
      "x-chain": "solana",
      accept: "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(
      `Birdeye /defi/v3/pair/overview/single returned ${resp.status} ${resp.statusText}`,
    );
  }
  const json = (await resp.json()) as {
    success: boolean;
    data?: {
      address: string;
      base?: { address?: string };
      quote?: { address?: string };
      liquidity?: number;
      volume_24h?: number;
      price?: number;
    };
  };
  if (!json.success || !json.data) {
    throw new Error(
      `Birdeye response indicates failure or missing data: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const d = json.data;
  return {
    address: d.address ?? poolAddress,
    tokenMintA: d.base?.address ?? "",
    tokenMintB: d.quote?.address ?? "",
    liquidityUsd: Number(d.liquidity ?? 0),
    volume24hUsd: Number(d.volume_24h ?? 0),
    volume7dUsd,
    feeTier,
    priceUsd: Number(d.price ?? 0),
    fetchedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Pool-level yield
// ---------------------------------------------------------------------------

/**
 * Pool-average daily fee yield per dollar of pooled capital.
 *
 *   r_pool = volume_24h × fee_tier / TVL
 *
 * Uses 24h volume by default (freshest). Pass `window = "7d"` for a
 * smoother estimate (less noise from single-day outliers).
 */
export function estimatePoolDailyYield(
  stats: PoolOverview,
  window: "24h" | "7d" = "24h",
): number {
  if (stats.liquidityUsd <= 0) return 0;
  const volume = window === "24h" ? stats.volume24hUsd : stats.volume7dUsd / 7;
  return (volume * stats.feeTier) / stats.liquidityUsd;
}

// ---------------------------------------------------------------------------
// In-range fraction under GBM
// ---------------------------------------------------------------------------

/** Standard normal CDF via erf approximation (Abramowitz–Stegun 7.1.26). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z / 2) /
      Math.sqrt(2 * Math.PI);
  return z >= 0 ? y : 1 - y;
}

/**
 * Probability that `S_t` lies inside a symmetric multiplicative range
 * `[S_0·(1−w), S_0·(1+w)]` at time `t`, under risk-neutral GBM with
 * drift `μ = −σ²/2` (martingale assumption, `r = 0`).
 *
 * Exact under GBM:
 *
 *   ln(S_t / S_0) ~ N(μ·t, σ²·t)
 *
 *   P = Φ((ln(1+w) − μ·t) / (σ·√t))  −  Φ((ln(1−w) − μ·t) / (σ·√t))
 */
export function inRangeProbabilityAt(
  widthBps: number,
  sigmaAnnualized: number,
  tYears: number,
): number {
  if (tYears <= 0) return 1;
  const w = widthBps / 10_000;
  if (w <= 0 || w >= 1) return w >= 1 ? 1 : 0;
  const mu = -0.5 * sigmaAnnualized * sigmaAnnualized;
  const s = sigmaAnnualized * Math.sqrt(tYears);
  const zUpper = (Math.log(1 + w) - mu * tYears) / s;
  const zLower = (Math.log(1 - w) - mu * tYears) / s;
  return normalCdf(zUpper) - normalCdf(zLower);
}

/**
 * Average fraction of the tenor `T` during which `S_t ∈ [p_l, p_u]`,
 * under risk-neutral GBM.
 *
 *   inRangeFraction = (1/T) · ∫_0^T P(S_t ∈ [p_l, p_u]) dt
 *
 * Numerical integration via composite Simpson (40 sub-intervals —
 * more than enough for a monotone integrand over a short tenor).
 */
export function inRangeFraction(
  widthBps: number,
  sigmaAnnualized: number,
  tenorSeconds: number,
  simpsonN: number = 40,
): number {
  if (tenorSeconds <= 0) return 1;
  const T = tenorSeconds / SECONDS_PER_YEAR;
  const n = simpsonN % 2 === 0 ? simpsonN : simpsonN + 1;
  const h = T / n;
  // Simpson's rule: t = 0 is always P=1; handle it explicitly because
  // our P() returns 1 at t=0 by convention (no time has elapsed).
  let sum = inRangeProbabilityAt(widthBps, sigmaAnnualized, 0) +
    inRangeProbabilityAt(widthBps, sigmaAnnualized, T);
  for (let i = 1; i < n; i++) {
    const t = i * h;
    sum += (i % 2 === 0 ? 2 : 4) *
      inRangeProbabilityAt(widthBps, sigmaAnnualized, t);
  }
  return Math.max(0, Math.min(1, (h / 3) * sum / T));
}

// ---------------------------------------------------------------------------
// Composite: position-level daily yield
// ---------------------------------------------------------------------------

export interface PositionYieldEstimate {
  poolDailyYield: number;
  inRangeFraction: number;
  concentrationFactor: number;
  positionDailyYield: number;
  tenorDays: number;
  source: PoolOverview;
}

/**
 * Position-level daily fee yield, combining pool measurement with
 * a width-aware time-in-range adjustment.
 *
 *   r_position = r_pool × inRangeFraction × concentrationFactor
 *
 * @param concentrationFactor
 *   Multiplier for the "our LP earns more fees per dollar while
 *   in-range than pool average" effect. Defaults to 1 — the honest
 *   under-estimate in the absence of tick-level pool data. Callers
 *   who have an empirical estimate (e.g. from on-chain swap-event
 *   aggregation) can pass a larger value.
 */
export function estimatePositionDailyYield(
  stats: PoolOverview,
  widthBps: number,
  sigmaAnnualized: number,
  tenorSeconds: number,
  concentrationFactor: number = 1,
  window: "24h" | "7d" = "24h",
): PositionYieldEstimate {
  const r_pool = estimatePoolDailyYield(stats, window);
  const irf = inRangeFraction(widthBps, sigmaAnnualized, tenorSeconds);
  return {
    poolDailyYield: r_pool,
    inRangeFraction: irf,
    concentrationFactor,
    positionDailyYield: r_pool * irf * concentrationFactor,
    tenorDays: tenorSeconds / 86_400,
    source: stats,
  };
}

// ---------------------------------------------------------------------------
// Concentration factor — on-chain first-order estimate
// ---------------------------------------------------------------------------

/**
 * Compute the concentration factor `c` that adjusts the pool-average
 * fee-yield benchmark into a position-specific expected yield.
 *
 * Derivation
 * ----------
 * Pool-average yield (uniform LP hypothesis):
 *
 *     r_pool = volume × fee_tier / TVL
 *
 * Our position earns fees only when in-range, and at a rate proportional
 * to its share of `L_active(t)`:
 *
 *     fee_rate_position(t)
 *       = I(S_t ∈ [p_l, p_u]) × (L_position / L_active(t))
 *         × volume_rate × fee_tier / V_position
 *
 * Taking expectations and using first-order constants (volume, L_active,
 * V_position all treated as fixed over the tenor), the ratio of the
 * position's per-$ yield to `r_pool × inRangeFraction` is:
 *
 *     c = (L_position × TVL) / (L_active × V_position)
 *
 * Both sides are dimensionless:
 *   - L_position, L_active are raw `u128` Whirlpool liquidity values
 *     (same units).
 *   - TVL and V_position are both in USD.
 *
 * Sanity cases
 * ------------
 *   - Uniform LP (L-share == V-share) → c = 1.
 *   - Concentrated LP (L-share > V-share) → c > 1.
 *   - Over-wide / diluted LP (L-share < V-share) → c < 1.
 *
 * First-order assumption
 * ----------------------
 * `L_active` is evaluated at the current tick (i.e. `whirlpool.liquidity`).
 * Under realistic paths with σ·√T ≪ width, the current tick's L_active is
 * a good proxy for the time-averaged L_active inside the position's range.
 * A tick-array-integrated upgrade is possible but not implemented here —
 * this function stays on data we already decode.
 *
 * Failure mode
 * ------------
 * Any degenerate input (non-positive denominators, NaN) returns `null`
 * so callers can fall back to c = 1 and log the event for governance.
 */
export function computeConcentrationFactor(params: {
  /** Position's concentrated-liquidity L (from `position.liquidity`). */
  L_position: bigint;
  /** Pool's current in-range L (from `whirlpool.liquidity`). */
  L_active: bigint;
  /** Position's USD value at entry (V(S_0)). */
  V_position_usd: number;
  /** Pool's total value locked in USD (from Birdeye or equivalent). */
  TVL_usd: number;
}): number | null {
  const { L_position, L_active, V_position_usd, TVL_usd } = params;
  if (L_active <= 0n) return null;
  if (V_position_usd <= 0) return null;
  if (TVL_usd <= 0) return null;
  if (L_position < 0n) return null;
  const shareL = Number(L_position) / Number(L_active);
  const shareV = V_position_usd / TVL_usd;
  if (!Number.isFinite(shareL) || !Number.isFinite(shareV) || shareV <= 0) {
    return null;
  }
  const c = shareL / shareV;
  if (!Number.isFinite(c) || c <= 0) return null;
  return c;
}
