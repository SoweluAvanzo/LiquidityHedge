/**
 * /api/simulate — portfolio Monte-Carlo over the owner's SOL/USDC
 * Whirlpool positions (FR-S1..S6).
 *
 *  GET  → { models } from the risk-model registry, so the UI renders
 *         config forms generically from each model's JSON Schema (FR-S5).
 *  POST → calibrate the chosen model on Birdeye daily SOL candles,
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
  getModel,
  listModels,
  sampleRatePaths,
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
import { estimatePoolDailyYield } from "@lh/core/src/market-data/orca-volume-adapter";
import {
  getPoolDailyCandles,
  getSolDailyCandles,
  SOL_MINT,
  birdeyeApiKey,
} from "@/lib/server/birdeye";
import {
  computeInRangeDailyRate,
  computePoolYieldBasis,
} from "@/lib/server/viability";
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
 */
const HEDGE_FEE_SPLIT_RATE = 0.1;

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
    const rate = pool ? await computeInRangeDailyRate(view, pool) : null;
    if (rate === null) return null;
    rates.push({
      positionAddress: view.positionAddress,
      ratePctPerDay: rate * 100,
      source: "measured",
    });
  }
  return rates;
}

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

  const perPool = new Map<string, { paths: number[][]; nObs: number }>();
  const yieldRates: ResolvedYieldRate[] = [];
  const ratePaths = new Map<string, number[][]>();
  const positionMeans: number[] = [];

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
    const { overview, concentrationFactor: c } = basis;

    let poolEntry = perPool.get(view.whirlpool);
    if (!poolEntry) {
      let params;
      try {
        const { candles } = await getPoolDailyCandles(view.whirlpool, req.windowDays);
        // Pair-OHLCV `v` is BASE-TOKEN volume (SOL), so v × close = USD
        // volume (verified against the overview's 24h USD figure). The
        // final candle is the in-progress day — a systematically low
        // partial observation — and is dropped. TVL held constant at the
        // current overview value (labeled in the echoed basis); feeTier is
        // the overview's decimal fraction.
        const complete = candles.slice(0, -1);
        const dailyRates = complete.map(
          (k) => (k.v * k.c * overview.feeTier) / overview.liquidityUsd,
        );
        params = calibrateFeeIntensity(dailyRates);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[api/simulate] fee-intensity calibration failed:", message);
        return {
          error:
            `Stochastic fee intensity unavailable (${message}). ` +
            'Use feeIntensityMode "constant" or retry later.',
        };
      }
      // Level anchor: user override (position-level) or the CURRENT
      // measured pool rate (pool-level; × c per position below).
      const sampled = sampleRatePaths(
        params,
        { nPaths: req.nPaths, steps: horizonSteps, seed: req.seed },
        {
          rescaleToMean:
            override !== undefined ? override / 100 : estimatePoolDailyYield(overview),
        },
      );
      poolEntry = { paths: sampled, nObs: params.dailyRates.length };
      perPool.set(view.whirlpool, poolEntry);
    }

    const measuredLevel = estimatePoolDailyYield(overview) * c;
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

  const nObs = Math.min(...[...perPool.values()].map((e) => e.nObs));
  const basisLabel =
    `birdeye-pool-volume shape (${nObs}d), level anchored to ` +
    (override !== undefined ? "user override" : "current measured rate");
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

  // 1. Positions — SOL/USDC only (the simulatable subset).
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
  const solViews = views.filter(
    (v) => v.tokenMintA === SOL_MINT && v.isUsdcQuoted,
  );
  if (solViews.length === 0) {
    return NextResponse.json(
      { error: "No SOL/USDC positions found for this owner — nothing to simulate." },
      { status: 422 },
    );
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
      const resolved = await resolveStochasticFeeIntensity(connection, solViews, req);
      if ("error" in resolved) {
        return NextResponse.json({ error: resolved.error }, { status: 422 });
      }
      yieldRates = resolved.yieldRates;
      feeIntensityEcho = resolved.feeIntensity;
      ratePathsByPosition = resolved.ratePaths;
    } else if (req.feeRatePctPerDayOverride !== undefined) {
      feeIntensityEcho = { mode: "constant" };
      yieldRates = solViews.map((v) => ({
        positionAddress: v.positionAddress,
        ratePctPerDay: req.feeRatePctPerDayOverride!,
        source: "override" as const,
      }));
    } else {
      feeIntensityEcho = { mode: "constant" };
      yieldRates = (await measureInRangeRates(connection, solViews)) ?? undefined;
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

  // 2b. History — daily SOL candles over the requested window, refused loudly
  //     when coverage is degraded (deliberate product rule, §E7).
  let history: AssetSeries | null = null;
  if (!gbmDirect) try {
    const { candles, coverage } = await getSolDailyCandles(req.windowDays);
    if (!coverage.complete) {
      return NextResponse.json(
        {
          error:
            `Market data quality insufficient: only ${coverage.received} of ` +
            `${coverage.expected} daily candles available for the ${req.windowDays}-day ` +
            `window (${(coverage.coverageRatio * 100).toFixed(1)}% coverage, ` +
            `${coverage.gaps} gaps). Degraded data is refused, not smoothed over.`,
        },
        { status: 422 },
      );
    }
    history = {
      assetId: "SOL",
      closes: candles.map((c) => c.c),
      stepSeconds: DAY_SECONDS,
    };
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
  const currentPrice = solViews[0].price;
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
      // Shape must match GbmParams (single asset, unit Cholesky).
      params = {
        assetIds: ["SOL"],
        s0: [currentPrice],
        sigma: sigmaOverride.slice(0, 1),
        mu: [cfg.driftMode === "custom" ? cfg.customDrift![0] : 0],
        chol: [[1]],
      };
    } else {
      params = model.calibrate([history!], req.config);
      // Rebase: paths must start at the price the positions are marked at,
      // not at the last historical close.
      (params as { s0: number[] }).s0 = [currentPrice];
    }

    const rateByPosition = new Map(
      (yieldRates ?? []).map((r) => [r.positionAddress, r.ratePctPerDay]),
    );
    const positions: SimPosition[] = solViews.map((v) => {
      const ratePctPerDay = rateByPosition.get(v.positionAddress);
      const ratePaths = ratePathsByPosition?.get(v.positionAddress);
      return {
        assetId: "SOL",
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

    const paths = model.simulatePaths(params, grid);
    const report = simulatePortfolio(paths, positions, {
      composition: req.composition,
      stepSeconds: DAY_SECONDS,
    });

    const body: SimulateResponse = {
      asOf: new Date().toISOString(),
      echo: {
        ...req,
        ...(yieldRates ? { yieldRates } : {}),
        ...(feeIntensityEcho ? { feeIntensity: feeIntensityEcho } : {}),
      },
      positionsCount: solViews.length,
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
