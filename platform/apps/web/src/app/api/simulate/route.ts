/**
 * /api/simulate — portfolio Monte-Carlo over the owner's USD-quoted
 * Whirlpool positions (FR-S1..S6).
 *
 * Multi-pair: every distinct base mint is one simulated asset, and all of
 * their histories are calibrated TOGETHER so the paths are drawn jointly.
 * That is what keeps portfolio risk honest — independent per-asset paths
 * would diversify away co-movement the portfolio does not actually enjoy.
 *
 *  GET  → { models } from the risk-model registry, so the UI renders
 *         config forms generically from each model's JSON Schema (FR-S5).
 *  POST → calibrate the chosen model on Birdeye daily candles,
 *         rebase to the live pool price, simulate, and report.
 *
 * Product rules enforced here:
 *  - Degraded OHLCV coverage is refused with 422 — never smoothed over.
 *  - Both models run on DAILY steps (stepSeconds = 86400): the empirical
 *    bootstrap resamples historical daily returns and cannot rescale time.
 *  - The response echoes the full effective config + seed (FR-S4):
 *    replaying it reproduces the report bit-identically.
 *  - Composable yield: `composition` selects value / value+yield / yield;
 *    the per-position IN-RANGE-CONDITIONAL rate comes from the same
 *    viability pipeline as /api/portfolio (or an explicit override) and is
 *    echoed back with its source — never silently guessed.
 */

import { type NextRequest, NextResponse } from "next/server";
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchPortfolio, type PortfolioPositionView } from "@lh/portfolio";
import {
  calibrateFeeIntensity,
  correlationReport,
  sampleSharedBlockIndices,
  ratePathsFromIndices,
  getModel,
  listModels,
  simulatePortfolio,
  type AssetSeries,
  type Composition,
  type SimPosition,
  type SimulationGrid,
} from "@lh/risk-models";
import {
  decodeWhirlpoolAccount,
  type WhirlpoolData,
} from "@lh/core/src/market-data/decoder";
import {
  getPoolDailyCandles,
  getTokenDailyCandles,
  birdeyeApiKey,
} from "@/lib/server/birdeye";
import { computePoolYieldBasis } from "@/lib/server/viability";
import { getStaticPricingParams } from "@/lib/server/pricing-params";
import {
  SIM_COMPOSITIONS,
  SIM_FEE_RATE_OVERRIDE_MAX_PCT,
  SIM_MAX_PATHS,
  SIM_MIN_PATHS,
  SIM_WINDOW_DAYS,
  type FeeIntensityEcho,
  type FeeIntensityMode,
  type ResolvedYieldRate,
  type SimulateRequest,
  type SimulateResponse,
  type SamplingMode,
  type CoMovementEffect,
  type SimWindowDays,
} from "@/lib/simulate-api";

// Live RPC + market data on every run — never cache the route output.
export const dynamic = "force-dynamic";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const DAY_SECONDS = 86_400;

/**
 * Certificate fee split y — the Master Terms assign y = 10% of the LP's
 * trading fees over the tenor to the Risk Taker at settlement (the same
 * y that discounts the premium: Premium = max(P_floor, FV·m_vol − y·E[F])).
 * Applied to accrued fees in yield-bearing compositions when hedged.
 * §1.8: read from the ONE pricing-params module — a second hardcoded y
 * beside it would recreate the A7 defect class.
 */
const HEDGE_FEE_SPLIT_RATE = getStaticPricingParams().feeSplitRate;

// ---------------------------------------------------------------------------
// Strict body validation
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Minimal JSON-Schema validator for the subset the risk models declare
 * (object → string-enum | number/integer with bounds | array-of-number).
 * Returns an error message or null. Kept generic on purpose (FR-S5):
 * adding a model must not require route changes.
 */
function validateConfig(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const name of required) {
    if (typeof name === "string" && config[name] === undefined) {
      return `config.${name} is required`;
    }
  }
  for (const [name, value] of Object.entries(config)) {
    const prop = properties[name];
    if (!isPlainObject(prop)) {
      if (schema.additionalProperties === false) {
        return `config.${name} is not a recognized option`;
      }
      continue;
    }
    const type = prop.type;
    if (type === "string") {
      if (typeof value !== "string") return `config.${name} must be a string`;
      if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
        return `config.${name} must be one of: ${prop.enum.join(", ")}`;
      }
    } else if (type === "number" || type === "integer") {
      if (!isFiniteNumber(value)) return `config.${name} must be a number`;
      if (type === "integer" && !Number.isInteger(value)) {
        return `config.${name} must be an integer`;
      }
      if (isFiniteNumber(prop.minimum) && value < prop.minimum) {
        return `config.${name} must be >= ${prop.minimum}`;
      }
      if (isFiniteNumber(prop.maximum) && value > prop.maximum) {
        return `config.${name} must be <= ${prop.maximum}`;
      }
      if (isFiniteNumber(prop.exclusiveMinimum) && value <= prop.exclusiveMinimum) {
        return `config.${name} must be > ${prop.exclusiveMinimum}`;
      }
    } else if (type === "array") {
      if (!Array.isArray(value)) return `config.${name} must be an array`;
      const items = isPlainObject(prop.items) ? prop.items : {};
      if (items.type === "number" || items.type === "integer") {
        for (const item of value) {
          if (!isFiniteNumber(item)) {
            return `config.${name} must contain only numbers`;
          }
          if (isFiniteNumber(items.exclusiveMinimum) && item <= items.exclusiveMinimum) {
            return `config.${name} entries must be > ${items.exclusiveMinimum}`;
          }
        }
      }
    }
    // Unknown property types pass through — the model's calibrate() is the
    // final authority and its errors map to 400 below.
  }
  return null;
}

/** Effective request: defaults applied, so `composition` is always set. */
type EffectiveRequest = SimulateRequest & {
  composition: Composition;
  feeIntensityMode: FeeIntensityMode;
  sampling: SamplingMode;
  compareSampling: boolean;
};

interface ValidatedRequest {
  owner: PublicKey;
  request: EffectiveRequest;
}

function validateBody(body: unknown): ValidatedRequest | { error: string } {
  if (!isPlainObject(body)) return { error: "Request body must be a JSON object." };

  if (typeof body.owner !== "string") {
    return { error: "`owner` must be a base58 Solana public key string." };
  }
  let owner: PublicKey;
  try {
    owner = new PublicKey(body.owner);
  } catch {
    return { error: "`owner` is not a valid base58 Solana public key." };
  }

  const models = listModels();
  if (typeof body.modelId !== "string" || !models.some((m) => m.id === body.modelId)) {
    return {
      error: `Unknown \`modelId\` — available: ${models.map((m) => m.id).join(", ")}.`,
    };
  }
  const descriptor = models.find((m) => m.id === body.modelId)!;

  if (!isPlainObject(body.config)) {
    return { error: "`config` must be an object (see GET /api/simulate for the schema)." };
  }
  const configError = validateConfig(body.config, descriptor.configSchema);
  if (configError) return { error: configError };

  if (!SIM_WINDOW_DAYS.includes(body.windowDays as SimWindowDays)) {
    return { error: `\`windowDays\` must be one of ${SIM_WINDOW_DAYS.join(", ")}.` };
  }

  if (
    !isFiniteNumber(body.horizonWeeks) ||
    !Number.isInteger(body.horizonWeeks) ||
    body.horizonWeeks < 1 ||
    body.horizonWeeks > 52
  ) {
    return { error: "`horizonWeeks` must be an integer between 1 and 52." };
  }

  if (
    !isFiniteNumber(body.nPaths) ||
    !Number.isInteger(body.nPaths) ||
    body.nPaths < SIM_MIN_PATHS
  ) {
    return { error: `\`nPaths\` must be an integer >= ${SIM_MIN_PATHS}.` };
  }
  const nPaths = Math.min(body.nPaths, SIM_MAX_PATHS); // clamp, never reject high

  if (
    body.sampling !== undefined &&
    body.sampling !== "joint" &&
    body.sampling !== "independent"
  ) {
    return { error: '`sampling` must be "joint" or "independent".' };
  }
  if (body.compareSampling !== undefined && typeof body.compareSampling !== "boolean") {
    return { error: "`compareSampling` must be a boolean." };
  }
  if (!isFiniteNumber(body.seed) || !Number.isInteger(body.seed)) {
    return { error: "`seed` must be an integer." };
  }

  if (typeof body.hedged !== "boolean") {
    return { error: "`hedged` must be a boolean." };
  }

  let premiumUsd: number | undefined;
  if (body.premiumUsd !== undefined) {
    if (!isFiniteNumber(body.premiumUsd) || body.premiumUsd < 0) {
      return { error: "`premiumUsd` must be a number >= 0." };
    }
    premiumUsd = body.premiumUsd;
  }

  let composition: Composition = "value";
  if (body.composition !== undefined) {
    if (!SIM_COMPOSITIONS.includes(body.composition as Composition)) {
      return {
        error: `\`composition\` must be one of: ${SIM_COMPOSITIONS.join(", ")}.`,
      };
    }
    composition = body.composition as Composition;
  }

  let feeRatePctPerDayOverride: number | undefined;
  if (body.feeRatePctPerDayOverride !== undefined) {
    if (
      !isFiniteNumber(body.feeRatePctPerDayOverride) ||
      body.feeRatePctPerDayOverride < 0 ||
      body.feeRatePctPerDayOverride > SIM_FEE_RATE_OVERRIDE_MAX_PCT
    ) {
      return {
        error:
          "`feeRatePctPerDayOverride` must be a number between 0 and " +
          `${SIM_FEE_RATE_OVERRIDE_MAX_PCT} (%/day, in-range-conditional).`,
      };
    }
    feeRatePctPerDayOverride = body.feeRatePctPerDayOverride;
  }

  let feeIntensityMode: FeeIntensityMode = "constant";
  if (body.feeIntensityMode !== undefined) {
    if (body.feeIntensityMode !== "constant" && body.feeIntensityMode !== "stochastic") {
      return { error: '`feeIntensityMode` must be "constant" or "stochastic".' };
    }
    feeIntensityMode = body.feeIntensityMode;
  }
  if (feeIntensityMode === "stochastic" && composition === "value") {
    return {
      error:
        'feeIntensityMode="stochastic" requires composition "value+yield" or "yield".',
    };
  }

  return {
    owner,
    request: {
      owner: owner.toBase58(),
      modelId: body.modelId,
      config: body.config,
      windowDays: body.windowDays as SimWindowDays,
      horizonWeeks: body.horizonWeeks,
      nPaths,
      seed: body.seed,
      sampling: body.sampling ?? "joint",
      compareSampling: body.compareSampling === true,
      hedged: body.hedged,
      premiumUsd,
      composition,
      feeRatePctPerDayOverride,
      feeIntensityMode,
    },
  };
}

// ---------------------------------------------------------------------------
// Yield-rate resolution (composition ≠ "value")
// ---------------------------------------------------------------------------

/**
 * Measured in-range-conditional rate per position, via the SAME viability
 * pipeline as /api/portfolio (computeInRangeDailyRate = poolDailyYield ×
 * concentrationFactor — the in-range fraction is excluded because the
 * engine applies the in-range indicator path-consistently).
 *
 * All-or-nothing: a partial mix of measured and faked rates would mislabel
 * the report, so ANY unavailable rate returns null.
 */
/**
 * Decode each distinct whirlpool once: feeRate (ppm) + active liquidity
 * are needed for the fee-yield measurement and are not part of the view.
 */
async function decodePools(
  connection: Connection,
  views: PortfolioPositionView[],
): Promise<Map<string, WhirlpoolData> | null> {
  const poolKeys = [...new Set(views.map((v) => v.whirlpool))];
  const pools = new Map<string, WhirlpoolData>();
  try {
    const infos = await connection.getMultipleAccountsInfo(
      poolKeys.map((k) => new PublicKey(k)),
    );
    poolKeys.forEach((key, i) => {
      const info = infos[i];
      if (!info) return;
      try {
        pools.set(key, decodeWhirlpoolAccount(info.data));
      } catch {
        // Undecodable pool → its positions' rates stay unavailable.
      }
    });
  } catch (error) {
    console.error("[api/simulate] whirlpool refetch failed:", error);
    return null;
  }
  return pools;
}

async function measureInRangeRates(
  connection: Connection,
  views: PortfolioPositionView[],
): Promise<ResolvedYieldRate[] | null> {
  const pools = await decodePools(connection, views);
  if (!pools) return null;

  const rates: ResolvedYieldRate[] = [];
  for (const view of views) {
    const pool = pools.get(view.whirlpool);
    // The basis carries its own provenance — a Birdeye-modelled rate
    // must echo as "modelled", not "measured" (audit F2: the constant
    // path labelled every fallback rate a measurement).
    const basis = pool ? await computePoolYieldBasis(view, pool) : null;
    if (!basis) return null;
    rates.push({
      positionAddress: view.positionAddress,
      ratePctPerDay: basis.poolDailyYield * basis.concentrationFactor * 100,
      source: basis.source === "measured-snapshots" ? "measured" : "modelled",
    });
  }
  return rates;
}

/** Mirrors `calibrateFeeIntensity`'s own defaults (fee-intensity.ts). */
const FEE_MIN_OBSERVATIONS = 60;
const FEE_BLOCK_LENGTH = 7;

interface StochasticResolution {
  yieldRates: ResolvedYieldRate[];
  feeIntensity: FeeIntensityEcho;
  /** Position-level in-range-conditional rate paths, nPaths × horizonSteps. */
  ratePaths: Map<string, number[][]>;
}

/**
 * Stochastic fee intensity: daily r_pool series from PAIR-level OHLCV
 * volume over the calibration window — r_pool(t) = v(t) × feeTier / TVL,
 * with TVL held at the CURRENT overview value (volume is the fast
 * variable; the label says so) — block-bootstrapped into per-path rate
 * series, deterministic under the run seed (FR-S4).
 *
 * LEVEL vs SHAPE: history sets only the fluctuation SHAPE (the ratio
 * v(t)/mean(v), which is TVL-free); the LEVEL is always anchored — to the
 * CURRENT measured pool rate (measured mode) or to the user override.
 * Anchoring is deliberate: the raw historical mean embeds the
 * TVL-held-constant distortion (a year of high-volume regime against
 * today's TVL measured ~9x above the live rate), and the current
 * measurement is the honest level, exactly as in constant mode.
 *
 * The sampled rates stay IN-RANGE-CONDITIONAL: measured mode scales each
 * pool path by the position's concentration factor c (day-by-day analogue
 * of constant mode's poolDailyYield × c); override paths are already
 * position-level — c is NOT applied again.
 */
async function resolveStochasticFeeIntensity(
  connection: Connection,
  views: PortfolioPositionView[],
  req: EffectiveRequest,
): Promise<StochasticResolution | { error: string }> {
  const pools = await decodePools(connection, views);
  const override = req.feeRatePctPerDayOverride;
  const horizonSteps = req.horizonWeeks * 7;

  // Pass 1 — calibrate every distinct pool. Nothing is sampled yet: the
  // pools must first be put on a common calendar so they can be resampled
  // together (see `sampleSharedBlockIndices`).
  interface PoolCal {
    /** Daily rate keyed by candle open time, so pools align by DATE. */
    byDay: Map<number, number>;
    anchorMean: number;
  }
  const cal = new Map<string, PoolCal>();
  const basisByPosition = new Map<
    string,
    { pool: string; basis: NonNullable<Awaited<ReturnType<typeof computePoolYieldBasis>>> }
  >();

  for (const view of views) {
    const pool = pools?.get(view.whirlpool);
    const basis = pool ? await computePoolYieldBasis(view, pool) : null;
    if (!basis) {
      return {
        error:
          "Yield rate unavailable (market data): supply " +
          "feeRatePctPerDayOverride or retry later.",
      };
    }
    basisByPosition.set(view.positionAddress, { pool: view.whirlpool, basis });

    if (cal.has(view.whirlpool)) continue;
    const { overview } = basis;
    if (!overview) {
      // The measured snapshot path can carry the LEVEL without Birdeye,
      // but the stochastic fluctuation SHAPE needs pair-volume history.
      return {
        error:
          "Stochastic fee intensity unavailable (pair-volume history " +
          'unreachable). Use feeIntensityMode "constant" or retry later.',
      };
    }
    try {
      const { candles } = await getPoolDailyCandles(view.whirlpool, req.windowDays);
      // Pair-OHLCV `v` is BASE-TOKEN volume, so v × close = USD volume
      // (verified against the overview's 24h USD figure). The final candle
      // is the in-progress day — a systematically low partial observation
      // — and is dropped. TVL held constant at the current overview value
      // (labeled in the echoed basis); feeTier is the overview's decimal
      // fraction.
      const complete = candles.slice(0, -1);
      const byDay = new Map<number, number>();
      for (const k of complete) {
        const rate = (k.v * k.c * overview.feeTier) / overview.liquidityUsd;
        // `k.c` is this pool's OWN base-token price, so each pool's rate
        // series is denominated against its own asset — pools never share
        // a price series, only resampled DATES.
        if (Number.isFinite(rate) && rate >= 0) byDay.set(k.t, rate);
      }
      // Validate this pool on its own before it joins the calendar, so a
      // thin pool fails with the calibrator's message rather than silently
      // shrinking the intersection later.
      calibrateFeeIntensity([...byDay.values()]);
      cal.set(view.whirlpool, {
        byDay,
        // §1.1: the LEVEL anchor is the basis's pool yield — measured
        // from snapshots when available, Birdeye-modelled otherwise —
        // matching constant mode. The candle series above sets only the
        // fluctuation SHAPE.
        anchorMean:
          override !== undefined ? override / 100 : basis.poolDailyYield,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[api/simulate] fee-intensity calibration failed:", message);
      return {
        error:
          `Stochastic fee intensity unavailable (${message}). ` +
          'Use feeIntensityMode "constant" or retry later.',
      };
    }
  }

  // Put the pools on a common calendar — the intersection of the days
  // every pool observed — so one index means one DATE across all of them,
  // then draw a single index matrix that every pool reads off.
  //
  // What is shared here is ONLY the dates. Each pool keeps its own volume
  // history, its own fee tier, its own TVL and therefore its own rate
  // distribution; each POSITION keeps its own concentration factor and its
  // own range. Sharing a rate series across pools, or a concentration
  // factor across positions, would be a real error — this is what makes
  // fee income co-move across pools the way it historically did without
  // conflating the pools themselves.
  const entries = [...cal.entries()];
  // Common calendar = the days EVERY pool observed. Aligning by position
  // in each array instead would pair different dates whenever one pool has
  // a gap, quietly destroying the co-movement the shared index exists to
  // preserve.
  const [, firstCal] = entries[0];
  let commonDays = [...firstCal.byDay.keys()];
  for (const [, c] of entries.slice(1)) {
    commonDays = commonDays.filter((t) => c.byDay.has(t));
  }
  commonDays.sort((a, b) => a - b);
  const nObs = commonDays.length;
  if (nObs < FEE_MIN_OBSERVATIONS) {
    return {
      error:
        `Stochastic fee intensity unavailable: the ${entries.length} pools in ` +
        `this portfolio share only ${nObs} common daily observations ` +
        `(minimum ${FEE_MIN_OBSERVATIONS}). Their histories do not overlap ` +
        `enough to resample them together. Use feeIntensityMode "constant", ` +
        `or shorten the window.`,
    };
  }
  const blockLength = FEE_BLOCK_LENGTH;
  // In independent mode each pool gets its own draw, so the toggle applies
  // to fee co-movement as well as price co-movement. Applying it to only
  // one of the two would make the comparison meaningless.
  const sharedIndices =
    req.sampling === "joint"
      ? sampleSharedBlockIndices({
          nPaths: req.nPaths,
          steps: horizonSteps,
          seed: req.seed,
          nObs,
          blockLength,
        })
      : null;

  const perPool = new Map<string, { paths: number[][]; nObs: number }>();
  entries.forEach(([pool, c], k) => {
    const aligned = commonDays.map((t) => c.byDay.get(t)!);
    const indices =
      sharedIndices ??
      sampleSharedBlockIndices({
        nPaths: req.nPaths,
        steps: horizonSteps,
        seed: req.seed + k * 7919,
        nObs,
        blockLength,
      });
    perPool.set(pool, {
      paths: ratePathsFromIndices(aligned, indices, { rescaleToMean: c.anchorMean }),
      nObs,
    });
  });

  // Pass 2 — attribute pool paths to positions, applying each position's
  // concentration factor (override paths are already position-level, so c
  // is NOT applied again).
  const yieldRates: ResolvedYieldRate[] = [];
  const ratePaths = new Map<string, number[][]>();
  const positionMeans: number[] = [];
  for (const view of views) {
    const entry = basisByPosition.get(view.positionAddress)!;
    const { concentrationFactor: c } = entry.basis;
    const poolEntry = perPool.get(entry.pool)!;
    const measuredLevel = entry.basis.poolDailyYield * c;
    yieldRates.push({
      positionAddress: view.positionAddress,
      ratePctPerDay: override !== undefined ? override : measuredLevel * 100,
      source: override !== undefined ? "override" : "measured",
    });
    ratePaths.set(
      view.positionAddress,
      override !== undefined
        ? poolEntry.paths
        : poolEntry.paths.map((row) => row.map((r) => r * c)),
    );
    positionMeans.push(override !== undefined ? override / 100 : measuredLevel);
  }

  // The level source is labelled from the ACTUAL basis: "measured" only
  // when every pool's yield came from fee-growth snapshots (§1.1).
  const levelSources = new Set(
    [...basisByPosition.values()].map((e) => e.basis.source),
  );
  const levelLabel =
    override !== undefined
      ? "user override"
      : levelSources.size === 1 && levelSources.has("measured-snapshots")
        ? "measured pool rate (fee-growth snapshots)"
        : levelSources.size === 1
          ? "modelled pool rate (birdeye fallback)"
          : "mixed measured/modelled pool rates";
  const basisLabel =
    `birdeye-pool-volume shape (${nObs}d), ` +
    (entries.length > 1
      ? `${req.sampling === "joint" ? "shared-date" : "independent"} resample across ` +
        `${entries.length} pools, `
      : "") +
    `level anchored to ${levelLabel}`;
  return {
    yieldRates,
    feeIntensity: {
      mode: "stochastic",
      basis: basisLabel,
      meanRatePctPerDay:
        (positionMeans.reduce((s, x) => s + x, 0) / positionMeans.length) * 100,
    },
    ratePaths,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET() {
  return NextResponse.json({ models: listModels() });
}

export async function POST(request: NextRequest) {
  // A10: cost-tiered rate limit, keyed on the trusted last hop. (This call
  // was missing while the import was present — quote and simulate are the
  // two most expensive routes, so leaving them unguarded defeated the fix.)
  const limit = checkLimit(request, "simulate");
  if (!limit.ok) return tooManyRequests(limit);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const validated = validateBody(raw);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { owner, request: req } = validated;

  if (!birdeyeApiKey()) {
    return NextResponse.json(
      { error: "Market data is not configured on this server (missing Birdeye credentials)." },
      { status: 503 },
    );
  }

  // 1. Positions — every USD-quoted pool (the simulatable subset).
  //    Each distinct base mint becomes one simulated asset; positions
  //    sharing a base mint share its price path, and the cross-asset
  //    correlation is carried by the model (see step 2b).
  const connection = new Connection(process.env.RPC_URL ?? DEFAULT_RPC_URL, "confirmed");
  let views: PortfolioPositionView[];
  try {
    views = await fetchPortfolio(connection, owner);
  } catch (error) {
    console.error("[api/simulate] portfolio fetch failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch portfolio from the RPC provider." },
      { status: 502 },
    );
  }
  const simViews = views.filter((v) => v.isUsdcQuoted);
  if (simViews.length === 0) {
    return NextResponse.json(
      {
        error:
          "No USD-quoted positions found for this owner — nothing to simulate. " +
          "Simulation requires a pool whose quote token is a USD stablecoin.",
      },
      { status: 422 },
    );
  }
  // Distinct base mints, in first-seen order — the asset axis of the run.
  const assetMints = [...new Set(simViews.map((v) => v.tokenMintA))];
  // Live mark per asset: the price of the first position holding it. Two
  // pools on the same base mint quote within arbitrage distance of each
  // other, so the choice is immaterial at simulation resolution.
  const priceByAsset = new Map<string, number>();
  for (const v of simViews) {
    if (!priceByAsset.has(v.tokenMintA)) priceByAsset.set(v.tokenMintA, v.price);
  }

  // 1b. Yield rates (composition ≠ "value"): an explicit override wins;
  //     otherwise the measured in-range-conditional rate. Unavailable
  //     measurements are refused, never guessed. Stochastic mode adds
  //     block-bootstrapped per-path rate series on top of the level.
  let yieldRates: ResolvedYieldRate[] | undefined;
  let feeIntensityEcho: FeeIntensityEcho | undefined;
  let ratePathsByPosition: Map<string, number[][]> | undefined;
  if (req.composition !== "value") {
    if (req.feeIntensityMode === "stochastic") {
      const resolved = await resolveStochasticFeeIntensity(connection, simViews, req);
      if ("error" in resolved) {
        return NextResponse.json({ error: resolved.error }, { status: 422 });
      }
      yieldRates = resolved.yieldRates;
      feeIntensityEcho = resolved.feeIntensity;
      ratePathsByPosition = resolved.ratePaths;
    } else if (req.feeRatePctPerDayOverride !== undefined) {
      feeIntensityEcho = { mode: "constant" };
      yieldRates = simViews.map((v) => ({
        positionAddress: v.positionAddress,
        ratePctPerDay: req.feeRatePctPerDayOverride!,
        source: "override" as const,
      }));
    } else {
      feeIntensityEcho = { mode: "constant" };
      yieldRates = (await measureInRangeRates(connection, simViews)) ?? undefined;
      if (!yieldRates) {
        return NextResponse.json(
          {
            error:
              "Yield rate unavailable (market data): supply " +
              "feeRatePctPerDayOverride or retry later.",
          },
          { status: 422 },
        );
      }
    }
  }

  // 2a. Direct GBM: with a user-supplied sigma override, GBM needs no
  //     historical calibration at all — the simulation runs even when the
  //     OHLCV provider is down (σ from the user, S₀ from the live pool).
  const cfg = req.config as {
    driftMode?: string;
    sigmaOverride?: unknown;
    customDrift?: number[];
  };
  const gbmDirect =
    req.modelId === "gbm" &&
    Array.isArray(cfg.sigmaOverride) &&
    cfg.sigmaOverride.length > 0 &&
    cfg.sigmaOverride.every((x) => typeof x === "number" && x > 0 && x < 10);
  if (gbmDirect && cfg.driftMode === "historical") {
    return NextResponse.json(
      {
        error:
          "driftMode=historical requires market-data calibration — with a sigma " +
          "override use driftMode zero or custom.",
      },
      { status: 400 },
    );
  }

  // 2b. History — one daily USD series per distinct base mint, over the
  //     requested window, refused loudly when coverage is degraded
  //     (deliberate product rule, §E7).
  //
  //     The series are handed to the model TOGETHER. That is what carries
  //     the cross-asset correlation: GBM estimates the correlation matrix
  //     and draws shocks through its Cholesky factor, while the bootstrap
  //     and replay models resample whole cross-asset return VECTORS, so
  //     they preserve the empirical co-movement by construction. Sampling
  //     each asset independently would understate portfolio tail risk,
  //     since Solana assets are strongly co-moving.
  let history: AssetSeries[] | null = null;
  if (!gbmDirect) try {
    const series: AssetSeries[] = [];
    for (const mint of assetMints) {
      const { candles, coverage } = await getTokenDailyCandles(mint, req.windowDays);
      if (!coverage.complete) {
        return NextResponse.json(
          {
            error:
              `Market data quality insufficient for ${mint}: only ` +
              `${coverage.received} of ${coverage.expected} daily candles ` +
              `available for the ${req.windowDays}-day window ` +
              `(${(coverage.coverageRatio * 100).toFixed(1)}% coverage, ` +
              `${coverage.gaps} gaps). Degraded data is refused, not smoothed over.`,
          },
          { status: 422 },
        );
      }
      series.push({
        assetId: mint,
        closes: candles.map((c) => c.c),
        stepSeconds: DAY_SECONDS,
      });
    }
    // Joint sampling needs one shared time axis. `jointLogReturns` aligns
    // on the SHORTEST series by taking each one's tail, so a token listed
    // more recently than the window silently shortens the calibration for
    // every asset. Refuse that rather than calibrate on a stub.
    const lengths = series.map((h) => h.closes.length);
    const shortest = Math.min(...lengths);
    const longest = Math.max(...lengths);
    if (shortest < longest * 0.9) {
      const worst = series[lengths.indexOf(shortest)].assetId;
      return NextResponse.json(
        {
          error:
            `Histories cannot be aligned: ${worst} has ${shortest} daily ` +
            `closes against ${longest} for the longest asset. Joint sampling ` +
            `would truncate every series to the shortest, so the run is ` +
            `refused. Shorten the window, or simulate the assets separately.`,
        },
        { status: 422 },
      );
    }
    history = series;
  } catch (error) {
    console.error("[api/simulate] candle ingestion failed:", error);
    return NextResponse.json(
      {
        error:
          "Failed to ingest market data from the OHLCV provider." +
          (req.modelId === "gbm"
            ? " Tip: set a Sigma override (e.g. 0.69) to run GBM without market data."
            : ""),
      },
      { status: 502 },
    );
  }

  // 3. Calibrate, rebase to the LIVE pool price, simulate.
  //    (Daily grid for both models: the bootstrap cannot rescale time.)
  const s0ByAsset = assetMints.map((m) => priceByAsset.get(m)!);
  const grid: SimulationGrid = {
    horizonSteps: req.horizonWeeks * 7,
    stepSeconds: DAY_SECONDS,
    nPaths: req.nPaths,
    seed: req.seed,
  };

  try {
    const model = getModel(req.modelId);
    let params: unknown;
    if (gbmDirect) {
      const sigmaOverride = cfg.sigmaOverride as number[];
      if (cfg.driftMode === "custom" && cfg.customDrift?.[0] === undefined) {
        return NextResponse.json(
          { error: "driftMode=custom requires customDrift." },
          { status: 400 },
        );
      }
      // A sigma override runs WITHOUT market data, which means there is no
      // sample to estimate cross-asset correlation from. For one asset that
      // is harmless (the Cholesky factor is [[1]]); for several it is not —
      // assuming independence would understate portfolio tail risk exactly
      // where it matters. Refuse rather than quietly diversify the risk away.
      if (assetMints.length > 1) {
        return NextResponse.json(
          {
            error:
              `A sigma override runs without market data, so the correlation ` +
              `between the ${assetMints.length} assets in this portfolio is ` +
              `unknown. Assuming independence would understate portfolio risk, ` +
              `so the run is refused. Remove the override to calibrate on ` +
              `history, or simulate a single pair.`,
          },
          { status: 422 },
        );
      }
      // Shape must match GbmParams (single asset, unit Cholesky).
      params = {
        assetIds: assetMints,
        s0: s0ByAsset,
        sigma: sigmaOverride.slice(0, 1),
        mu: [cfg.driftMode === "custom" ? cfg.customDrift![0] : 0],
        chol: [[1]],
      };
    } else {
      params = model.calibrate(history!, req.config);
      // Rebase: paths must start at the price the positions are marked at,
      // not at the last historical close. Order matches `assetMints`,
      // which is also the order the history series were built in.
      (params as { s0: number[] }).s0 = s0ByAsset;
    }

    const multiAsset = assetMints.length > 1 && !gbmDirect;

    // AUDIT #12: `historical-replay` derives its window starts from the
    // history length alone and IGNORES grid.seed, so the "independent"
    // variant came out bit-identical to the joint one. The comparison then
    // reported dispersionRatio = 1.000 and the UI concluded "correlation
    // makes no material difference" — on portfolios where it makes all the
    // difference. Refuse rather than report a falsehood.
    const deterministicModel = req.modelId === "historical-replay";
    if (multiAsset && deterministicModel &&
        (req.sampling === "independent" || req.compareSampling)) {
      return NextResponse.json(
        {
          error:
            "Historical replay is deterministic — it replays real windows " +
            "rather than drawing paths, so there is no independent variant " +
            "to compare against and any co-movement figure would be " +
            "meaningless. Use GBM or the empirical bootstrap to measure the " +
            "co-movement effect.",
        },
        { status: 422 },
      );
    }
    const buildPaths = (mode: SamplingMode) => {
      if (mode === "independent" && multiAsset) {
        const perAsset = history!.map((series, a) => {
          const p = model.calibrate([series], req.config) as { s0: number[] };
          p.s0 = [s0ByAsset[a]];
          // Vary the seed per asset; identical seeds would re-couple them.
          return model.simulatePaths(p, { ...grid, seed: grid.seed + a * 7919 });
        });
        // AUDIT #14: per-asset path counts can differ (the route accepts
        // histories differing by up to 10%, and some models derive their
        // path count from history length). Claiming asset 0's count while
        // another asset has fewer rows indexed past the end of the array.
        const nPaths = Math.min(...perAsset.map((pp) => pp.nPaths));
        const steps = Math.min(...perAsset.map((pp) => pp.steps));
        return {
          assetIds: assetMints,
          nPaths,
          steps,
          prices: perAsset.map((pp) =>
            pp.prices[0].slice(0, nPaths).map((row) => row.slice(0, steps)),
          ),
        };
      }
      return model.simulatePaths(params, grid);
    };
    const paths = buildPaths(req.sampling);

    const rateByPosition = new Map(
      (yieldRates ?? []).map((r) => [r.positionAddress, r.ratePctPerDay]),
    );
    const buildPositions = (
      rp: Map<string, number[][]> | undefined,
    ): SimPosition[] => simViews.map((v) => {
      const ratePctPerDay = rateByPosition.get(v.positionAddress);
      const ratePaths = rp?.get(v.positionAddress);
      return {
        assetId: v.tokenMintA,
        liquidity: v.liquidity,
        tickLower: v.tickLower,
        tickUpper: v.tickUpper,
        decimalsA: v.decimalsA,
        decimalsB: v.decimalsB,
        // IN-RANGE-CONDITIONAL daily rate — the engine applies the
        // in-range indicator itself, path-consistently. In stochastic
        // mode the sampled ratePaths take precedence step-by-step;
        // inRangeDailyRate stays as the echoed level.
        ...(ratePctPerDay !== undefined
          ? {
              yield: {
                inRangeDailyRate: ratePctPerDay / 100,
                ...(ratePaths ? { ratePaths } : {}),
              },
            }
          : {}),
        ...(req.hedged
          ? {
              hedge: {
                premiumUsd: req.premiumUsd ?? 0,
                // Master Terms fee split: y = 10% of accrued LP fees go to
                // the Risk Taker at settlement (see HEDGE_FEE_SPLIT_RATE).
                feeSplitRate: HEDGE_FEE_SPLIT_RATE,
              },
            }
          : {}),
      };
    });
    // AUDIT #13: fee rate paths are sized on req.nPaths, but a model may
    // return FEWER (historical replay caps at the number of available
    // windows: 2000 requested -> 183 returned at the UI's own defaults).
    // The engine then rejected the dimension mismatch and the internal
    // error surfaced as an HTTP 400. The rows are iid bootstrap draws, so
    // taking the first `paths.nPaths` of them is unbiased.
    const fitRatePaths = (
      rp: Map<string, number[][]> | undefined,
    ): Map<string, number[][]> | undefined => {
      if (!rp) return rp;
      const want = paths.nPaths;
      const wantCols = paths.steps - 1;
      let needsFit = false;
      for (const rows of rp.values()) {
        if (rows.length !== want || (rows[0]?.length ?? 0) !== wantCols) {
          needsFit = true;
          break;
        }
      }
      if (!needsFit) return rp;
      const out = new Map<string, number[][]>();
      for (const [k, rows] of rp) {
        out.set(k, rows.slice(0, want).map((r) => r.slice(0, wantCols)));
      }
      return out;
    };

    const positions = buildPositions(fitRatePaths(ratePathsByPosition));

    // Independent mode re-runs the model once per asset on its own seed
    // and stitches the results, so each asset is drawn from its own
    // marginal with no co-movement. It exists to be COMPARED against the
    // joint run — the gap between them is the portfolio's co-movement —
    // and is never the honest standalone risk figure.
    const report = simulatePortfolio(paths, positions, {
      composition: req.composition,
      stepSeconds: DAY_SECONDS,
    });

    // Co-movement effect: the same portfolio priced BOTH ways, so the
    // diversification the correlation actually buys (or costs) is a number
    // rather than an inference. Opt-in — it doubles the simulation.
    //
    // Both legs switch together: prices AND fee resampling. Flipping only
    // the price side would attribute fee co-movement to diversification.
    let comovement: CoMovementEffect | null = null;
    if (req.compareSampling && multiAsset) {
      const otherMode: SamplingMode =
        req.sampling === "joint" ? "independent" : "joint";
      let otherRates = ratePathsByPosition;
      if (req.composition !== "value" && req.feeIntensityMode === "stochastic") {
        // Candles are cached, so this repeats the resampling, not the I/O.
        const re = await resolveStochasticFeeIntensity(connection, simViews, {
          ...req,
          sampling: otherMode,
        });
        if (!("error" in re)) otherRates = re.ratePaths;
      }
      const otherReport = simulatePortfolio(
        buildPaths(otherMode),
        buildPositions(fitRatePaths(otherRates)),
        { composition: req.composition, stepSeconds: DAY_SECONDS },
      );
      const joint = req.sampling === "joint" ? report : otherReport;
      const indep = req.sampling === "joint" ? otherReport : report;
      comovement = {
        jointStd: joint.terminal.std,
        independentStd: indep.terminal.std,
        dispersionRatio:
          indep.terminal.std > 0 ? joint.terminal.std / indep.terminal.std : 1,
        jointVar5: joint.terminal.var5,
        independentVar5: indep.terminal.var5,
        jointCvar5: joint.terminal.cvar5,
        independentCvar5: indep.terminal.cvar5,
        var5DeltaUsd: joint.terminal.var5 - indep.terminal.var5,
      };
    }

    const body: SimulateResponse = {
      asOf: new Date().toISOString(),
      echo: {
        ...req,
        ...(yieldRates ? { yieldRates } : {}),
        ...(feeIntensityEcho ? { feeIntensity: feeIntensityEcho } : {}),
      },
      positionsCount: simViews.length,
      assets: assetMints,
      correlation:
        history && history.length > 1 ? correlationReport(history) : null,
      sampling: req.sampling,
      executedPaths: paths.nPaths,
      comovement,
      report,
    };
    return NextResponse.json(body);
  } catch (error) {
    // Calibration rejections (e.g. missing customDrift, too-short history)
    // are user-addressable → 400 with the model's message.
    const message = error instanceof Error ? error.message : "simulation failed";
    console.error("[api/simulate] simulation failed:", error);
    return NextResponse.json({ error: `Simulation failed: ${message}` }, { status: 400 });
  }
}
