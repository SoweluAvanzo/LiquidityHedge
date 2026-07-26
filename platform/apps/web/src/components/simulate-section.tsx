"use client";

/**
 * Simulate section (FR-S1..S6): Monte-Carlo the loaded portfolio's
 * SOL/USDC positions over a configurable model, window and horizon.
 *
 * The model catalog and each model's config form come from
 * GET /api/simulate — the form is rendered GENERICALLY from the model's
 * JSON Schema (FR-S5): adding a model requires no UI change here.
 * Every run echoes its full config + seed back (FR-S4 reproducibility).
 */

import { useEffect, useMemo, useState } from "react";
import type { Composition, RiskModelDescriptor } from "@lh/risk-models";
import type {
  SimulateRequest,
  SimulateResponse,
  SimWindowDays,
} from "@/lib/simulate-api";
import { formatUsd } from "@/lib/format";
import { FanChart } from "@/components/fan-chart";
import { SchemaConfigForm } from "@/components/schema-config-form";

const WINDOW_OPTIONS: { value: SimWindowDays; label: string }[] = [
  { value: 365, label: "1 year" },
  { value: 730, label: "2 years" },
  { value: 1095, label: "3 years" },
];

const COMPOSITION_OPTIONS: { value: Composition; label: string }[] = [
  { value: "value", label: "Value only" },
  { value: "value+yield", label: "Value + yield" },
  { value: "yield", label: "Yield only" },
];

/** How the composition reads in result headers ("value + yield, unhedged"). */
const COMPOSITION_LABEL: Record<Composition, string> = {
  value: "value",
  "value+yield": "value + yield",
  yield: "yield",
};

/** Fan-chart y-axis caption per composition. */
const COMPOSITION_Y_CAPTION: Record<Composition, string> = {
  value: "portfolio value",
  "value+yield": "portfolio value + accrued fees",
  yield: "accrued fees",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Seed a config from the schema's declared defaults (required-first). */
function defaultConfig(schema: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  for (const [name, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop)) continue;
    if (prop.default !== undefined) {
      config[name] = prop.default;
    } else if (required.has(name) && Array.isArray(prop.enum) && prop.enum.length > 0) {
      config[name] = prop.enum[0];
    }
  }
  return config;
}

/** Signed P&L: explicit plus sign so gains and losses read instantly. */
function formatPnl(v: number): string {
  return v >= 0 ? `+${formatUsd(v)}` : formatUsd(v);
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** Rate in %/day: "0.30" once >= 0.1, "0.041" below (estimator-label style). */
function formatRatePct(v: number): string {
  return v.toFixed(Math.abs(v) >= 0.1 ? 2 : 3);
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight">{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

function TerminalTiles({
  title,
  stats,
}: {
  title: string;
  stats: { mean: number; std: number; var5: number; cvar5: number; pLoss: number };
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{title}</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Mean P&L" value={formatPnl(stats.mean)} />
        <StatTile label="Std dev" value={formatUsd(stats.std)} />
        <StatTile label="VaR 5%" value={formatPnl(stats.var5)} />
        <StatTile label="CVaR 5%" value={formatPnl(stats.cvar5)} />
        <StatTile label="P(loss)" value={formatPct(stats.pLoss)} />
      </div>
    </div>
  );
}

const controlClass =
  "w-full rounded-md border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:focus:border-zinc-400";

export function SimulateSection({ owner }: { owner: string }) {
  const [models, setModels] = useState<RiskModelDescriptor[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [modelId, setModelId] = useState<string>("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [windowDays, setWindowDays] = useState<SimWindowDays>(365);
  const [horizonWeeks, setHorizonWeeks] = useState(26);
  const [nPaths, setNPaths] = useState(2000);
  const [seed, setSeed] = useState(42);
  const [hedged, setHedged] = useState(false);
  const [premiumUsd, setPremiumUsd] = useState(0);
  const [composition, setComposition] = useState<Composition>("value");
  // Kept as a string so "empty" (= use the measured rate) stays distinct
  // from an explicit 0%/day override.
  const [feeRateOverride, setFeeRateOverride] = useState("");
  const [stochasticFee, setStochasticFee] = useState(false);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulateResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/simulate", { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (cancelled) return;
        const list = body.models as RiskModelDescriptor[];
        setModels(list);
        if (list.length > 0) {
          setModelId(list[0].id);
          setConfig(defaultConfig(list[0].configSchema));
        }
      } catch (err) {
        if (!cancelled) {
          setModelsError(
            err instanceof Error ? err.message : "Failed to load model catalog.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedModel = useMemo(
    () => models?.find((m) => m.id === modelId) ?? null,
    [models, modelId],
  );

  const selectModel = (id: string) => {
    setModelId(id);
    const descriptor = models?.find((m) => m.id === id);
    setConfig(descriptor ? defaultConfig(descriptor.configSchema) : {});
  };

  const run = async () => {
    if (!modelId || running) return;
    setRunning(true);
    setRunError(null);
    const overrideNum =
      feeRateOverride.trim() === "" ? undefined : Number(feeRateOverride);
    const body: SimulateRequest = {
      owner,
      modelId,
      config,
      windowDays,
      horizonWeeks,
      nPaths,
      seed,
      hedged,
      ...(hedged ? { premiumUsd } : {}),
      composition,
      ...(composition !== "value" &&
      overrideNum !== undefined &&
      Number.isFinite(overrideNum)
        ? { feeRatePctPerDayOverride: overrideNum }
        : {}),
      ...(composition !== "value"
        ? { feeIntensityMode: stochasticFee ? ("stochastic" as const) : ("constant" as const) }
        : {}),
    };
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : `Request failed (${res.status})`,
        );
      }
      setResult(payload as SimulateResponse);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Simulation failed.");
    } finally {
      setRunning(false);
    }
  };

  const report = result?.report ?? null;
  // Composition OF THE DISPLAYED RESULT (not the control's current value —
  // the user may have changed it since the last run).
  const reportComposition: Composition = report?.composition ?? "value";

  // "rate source: measured 0.041%/day (in-range-conditional)" — resolved
  // per-position rates echoed by the server, transparency-labeled like the
  // portfolio card's estimator notes.
  const rateSourceText = (() => {
    const rates = result?.echo.yieldRates;
    if (!rates || rates.length === 0) return null;
    const rateText = `${[...new Set(rates.map((r) => formatRatePct(r.ratePctPerDay)))].join(" / ")}%/day`;
    const source =
      rates[0].source === "override"
        ? `rate source: user override ${rateText}`
        : `rate source: measured ${rateText} (in-range-conditional)`;
    // Fee-intensity dynamics: name the data basis verbatim when the rate
    // fluctuates along paths — same transparency policy as the estimator
    // labels.
    const fi = result?.echo.feeIntensity;
    return fi?.mode === "stochastic" && fi.basis
      ? `${source} · stochastic volume (${fi.basis})`
      : source;
  })();

  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Simulate</h2>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Monte-Carlo over the SOL/USDC positions of this portfolio
        </span>
      </header>

      {modelsError ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {modelsError}
        </p>
      ) : !models ? (
        <div
          className="mt-4 h-24 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          aria-hidden="true"
        />
      ) : (
        <>
          {/* Run configuration — one block above the results it scopes */}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="sim-model"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Model
              </label>
              <select
                id="sim-model"
                value={modelId}
                disabled={running}
                onChange={(e) => selectModel(e.target.value)}
                className={controlClass}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="sim-window"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Calibration window
              </label>
              <select
                id="sim-window"
                value={windowDays}
                disabled={running}
                onChange={(e) => setWindowDays(Number(e.target.value) as SimWindowDays)}
                className={controlClass}
              >
                {WINDOW_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="sim-horizon"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Horizon: {horizonWeeks} week{horizonWeeks === 1 ? "" : "s"}
              </label>
              <input
                id="sim-horizon"
                type="range"
                min={1}
                max={52}
                step={1}
                value={horizonWeeks}
                disabled={running}
                onChange={(e) => setHorizonWeeks(Number(e.target.value))}
                className="h-8 w-full accent-[var(--chart-series)]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="sim-paths"
                  className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  Paths (max 5000)
                </label>
                <input
                  id="sim-paths"
                  type="number"
                  min={100}
                  max={5000}
                  step={100}
                  value={nPaths}
                  disabled={running}
                  onChange={(e) => setNPaths(Number(e.target.value))}
                  className={controlClass}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="sim-seed"
                  className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  Seed
                </label>
                <input
                  id="sim-seed"
                  type="number"
                  step={1}
                  value={seed}
                  disabled={running}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  className={controlClass}
                />
              </div>
            </div>
          </div>

          {/* Model config — rendered generically from the JSON Schema */}
          {selectedModel && (
            <div className="mt-3">
              <SchemaConfigForm
                key={selectedModel.id}
                schema={selectedModel.configSchema}
                config={config}
                onChange={setConfig}
                disabled={running}
              />
            </div>
          )}

          {/* Composition — which component the report describes */}
          <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="flex flex-col gap-1">
              <span
                id="sim-composition-label"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Composition
              </span>
              <div
                role="radiogroup"
                aria-labelledby="sim-composition-label"
                className="inline-flex w-fit overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700"
              >
                {COMPOSITION_OPTIONS.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={composition === o.value}
                    disabled={running}
                    onClick={() => setComposition(o.value)}
                    className={`px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
                      i > 0 ? "border-l border-zinc-300 dark:border-zinc-700" : ""
                    } ${
                      composition === o.value
                        ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            {composition !== "value" && (
              <>
                <div className="flex min-w-64 flex-1 flex-col gap-1 sm:max-w-xs">
                  <label
                    htmlFor="sim-fee-rate"
                    className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
                  >
                    Fee rate override (%/day, in-range)
                  </label>
                  <input
                    id="sim-fee-rate"
                    type="number"
                    min={0}
                    max={5}
                    step={0.01}
                    value={feeRateOverride}
                    placeholder="measured"
                    disabled={running}
                    onChange={(e) => setFeeRateOverride(e.target.value)}
                    className={controlClass}
                  />
                  <p className="text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                    Leave empty to use the measured rate. This is the rate WHILE
                    in range — the simulation applies your range occupancy
                    path-by-path.
                  </p>
                </div>
                <div className="flex min-w-64 flex-1 flex-col gap-1 sm:max-w-xs">
                  <label className="flex items-center gap-2 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={stochasticFee}
                      disabled={running}
                      onChange={(e) => setStochasticFee(e.target.checked)}
                      className="h-4 w-4 accent-[var(--chart-series)]"
                    />
                    Model volume fluctuations (stochastic fee intensity)
                  </label>
                  <p className="text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                    Resamples the pool&apos;s historical daily volume shape
                    (Birdeye pool volume, block bootstrap), so the fee rate
                    fluctuates along each path. The level stays anchored to the
                    measured rate — or to your override, with history setting
                    only the fluctuations.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Hedge overlay */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={hedged}
                disabled={running}
                onChange={(e) => setHedged(e.target.checked)}
                className="h-4 w-4 accent-[var(--chart-series)]"
              />
              Hedged (Liquidity Hedge certificate held to horizon)
            </label>
            {hedged && (
              <div className="flex min-w-64 flex-1 flex-col gap-1 sm:max-w-xs">
                <label
                  htmlFor="sim-premium"
                  className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  Premium per certificate, USD
                </label>
                <input
                  id="sim-premium"
                  type="number"
                  min={0}
                  step={0.01}
                  value={premiumUsd}
                  disabled={running}
                  onChange={(e) => setPremiumUsd(Math.max(0, Number(e.target.value)))}
                  className={controlClass}
                />
                <p className="text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                  Enter a quoted premium; live quoting arrives with the Hedge
                  module.
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={run}
              disabled={running || !modelId}
              className="rounded-md border border-zinc-300 px-4 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {running ? "Simulating…" : "Run simulation"}
            </button>
            {running && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400" role="status">
                Running {nPaths.toLocaleString("en-US")} paths over{" "}
                {horizonWeeks * 7} daily steps…
              </span>
            )}
          </div>

          {runError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
              {runError}
            </p>
          )}

          {/* Results — previous render held at reduced opacity on re-run */}
          {result && report && (
            <div
              className={`mt-5 flex flex-col gap-4 transition-opacity ${running ? "opacity-60" : ""}`}
              aria-busy={running}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs text-zinc-500 dark:text-zinc-400">
                  {reportComposition === "yield"
                    ? "Accrued-fees fan"
                    : "Portfolio value fan"}{" "}
                  — {result.positionsCount} position
                  {result.positionsCount === 1 ? "" : "s"}, initial{" "}
                  {formatUsd(report.initialValue)}
                </h3>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {result.echo.modelId} · seed {result.echo.seed} ·{" "}
                  {result.echo.nPaths.toLocaleString("en-US")} paths ·{" "}
                  {result.echo.windowDays}d window
                </span>
              </div>

              {/* Estimator transparency: in-range behavior in these results
                  is a property of the chosen path model, not of the
                  portfolio card's in-range estimator. */}
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                In-range dynamics implied by{" "}
                {models.find((m) => m.id === result.echo.modelId)?.label ??
                  result.echo.modelId}{" "}
                paths — each simulation mode produces its own in-range behavior
                by construction.
              </p>

              <FanChart
                fan={report.fan}
                // Yield-only series starts from zero accrued fees — the
                // position's value is not on this axis.
                initialValue={reportComposition === "yield" ? 0 : report.initialValue}
                yCaption={COMPOSITION_Y_CAPTION[reportComposition]}
              />

              <div
                className={`grid grid-cols-1 gap-4 ${report.hedgedTerminal ? "lg:grid-cols-2" : ""}`}
              >
                <TerminalTiles
                  title={`Terminal P&L at ${result.echo.horizonWeeks}w — ${COMPOSITION_LABEL[reportComposition]}, unhedged`}
                  stats={report.terminal}
                />
                {report.hedgedTerminal && (
                  <TerminalTiles
                    title={`Terminal P&L at ${result.echo.horizonWeeks}w — ${COMPOSITION_LABEL[reportComposition]}, hedged (net of ${formatUsd(result.echo.premiumUsd ?? 0)} premium per certificate)`}
                    stats={report.hedgedTerminal}
                  />
                )}
              </div>

              {/* Yield transparency: accrued mean + the rate actually used */}
              {reportComposition !== "value" && rateSourceText && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Yield: mean accrued {formatUsd(report.meanAccruedYieldUsd)}{" "}
                  over the horizon · {rateSourceText}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <StatTile
                  label="Max drawdown (median)"
                  value={formatUsd(report.maxDrawdown.p50)}
                />
                <StatTile
                  label="Max drawdown (p95)"
                  value={formatUsd(report.maxDrawdown.p95)}
                />
                <StatTile
                  label="P(exit range)"
                  value={formatPct(report.pExitRange)}
                  sub="any position, any step"
                />
              </div>

              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Hypothetical simulation — not a prediction.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
