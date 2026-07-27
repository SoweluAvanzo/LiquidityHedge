"use client";

/**
 * Simulate section (FR-S1..S6): Monte-Carlo the loaded portfolio's
 * USD-quoted positions over a configurable model, window and horizon.
 * Multi-pair: each distinct base token is one simulated asset and the
 * paths are drawn jointly, so the reported dispersion carries the assets'
 * historical co-movement rather than diversifying it away.
 *
 * The model catalog and each model's config form come from
 * GET /api/simulate — the form is rendered GENERICALLY from the model's
 * JSON Schema (FR-S5): adding a model requires no UI change here.
 * Every run echoes its full config + seed back (FR-S4 reproducibility).
 *
 * The controls are grouped Model / Horizon / Composition / Advanced.
 * Nothing was removed in the grouping: paths, seed and the hedge overlay
 * still do exactly what they did, they just start folded away because
 * their defaults are the right answer for almost every run.
 */

import { useEffect, useMemo, useState } from "react";
import type { Composition, RiskModelDescriptor } from "@lh/risk-models";
import type {
  SimulateRequest,
  SimulateResponse,
  SamplingMode,
  SimWindowDays,
} from "@/lib/simulate-api";
import { apiFetch, errorMessage, retryAtFrom } from "@/lib/api-client";
import {
  formatPercent,
  formatRatePct,
  formatUsd,
  formatUsdSigned,
} from "@/lib/format";
import { RateLimitNotice } from "@/components/ui/rate-limit-notice";
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
/** Base58 mints are unreadable in a table header; the ends identify them. */
function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

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
    } else if (
      required.has(name) &&
      Array.isArray(prop.enum) &&
      prop.enum.length > 0
    ) {
      config[name] = prop.enum[0];
    }
  }
  return config;
}

function Fact({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="lh-fact">
      <span className="lh-fact-label">{label}</span>
      <p className="lh-fact-value">{value}</p>
      {sub && <p className="lh-fact-sub">{sub}</p>}
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
    <div>
      <p className="lh-label-block" style={{ marginBottom: "0.5rem" }}>
        {title}
      </p>
      <div className="lh-facts lh-facts-5">
        <Fact label="Mean P&L" value={formatUsdSigned(stats.mean)} />
        <Fact label="Std dev" value={formatUsd(stats.std)} />
        <Fact label="VaR 5%" value={formatUsdSigned(stats.var5)} />
        <Fact label="CVaR 5%" value={formatUsdSigned(stats.cvar5)} />
        <Fact label="P(loss)" value={formatPercent(stats.pLoss)} />
      </div>
    </div>
  );
}

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
  const [sampling, setSampling] = useState<SamplingMode>("joint");
  const [compareSampling, setCompareSampling] = useState(false);
  // Kept as a string so "empty" (= use the measured rate) stays distinct
  // from an explicit 0%/day override.
  const [feeRateOverride, setFeeRateOverride] = useState("");
  const [stochasticFee, setStochasticFee] = useState(false);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Set when /api/simulate answered 429 (6 runs a minute).
  const [retryAtTs, setRetryAtTs] = useState<number | null>(null);
  const [result, setResult] = useState<SimulateResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await apiFetch<{ models: RiskModelDescriptor[] }>(
          "/api/simulate",
        );
        if (cancelled) return;
        const list = body.models;
        setModels(list);
        if (list.length > 0) {
          setModelId(list[0].id);
          setConfig(defaultConfig(list[0].configSchema));
        }
      } catch (err) {
        if (!cancelled) {
          setModelsError(errorMessage(err, "Failed to load model catalog."));
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
    setRetryAtTs(null);
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
      // Cross-asset sampling governs the PRICE paths, so it is meaningful
      // in every composition — including the default "value". Only the
      // fee-intensity mode is yield-specific.
      sampling,
      compareSampling,
      ...(composition !== "value"
        ? {
            feeIntensityMode: stochasticFee
              ? ("stochastic" as const)
              : ("constant" as const),
          }
        : {}),
    };
    try {
      const payload = await apiFetch<SimulateResponse>("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setResult(payload);
    } catch (err) {
      setRetryAtTs(retryAtFrom(err));
      setRunError(errorMessage(err, "Simulation failed."));
    } finally {
      setRunning(false);
    }
  };

  const report = result?.report ?? null;
  // Composition OF THE DISPLAYED RESULT (not the control's current value —
  // the user may have changed it since the last run).
  const reportComposition: Composition = report?.composition ?? "value";

  // "measured 0.041%/day (in-range-conditional)" — resolved per-position
  // rates echoed by the server, labelled like the portfolio card's
  // estimator provenance.
  const rateSource = (() => {
    const rates = result?.echo.yieldRates;
    if (!rates || rates.length === 0) return null;
    const rateText = `${[...new Set(rates.map((r) => formatRatePct(r.ratePctPerDay)))].join(" / ")}%/day`;
    const sources = new Set(rates.map((r) => r.source));
    const value = sources.has("override")
      ? `user override ${rateText}`
      : sources.has("modelled")
        ? `${sources.has("measured") ? "measured/modelled mix" : "modelled (Birdeye fallback)"} ${rateText} (in-range-conditional)`
        : `measured ${rateText} (in-range-conditional)`;
    // Fee-intensity dynamics: name the data basis verbatim when the rate
    // fluctuates along paths — same transparency policy as the estimator
    // labels.
    const fi = result?.echo.feeIntensity;
    return fi?.mode === "stochastic" && fi.basis
      ? `${value} · stochastic volume (${fi.basis})`
      : value;
  })();

  return (
    <section className="lh-card" aria-labelledby="sim-h">
      <header className="lh-card-head">
        <h2 className="lh-h2" id="sim-h">
          Simulate
        </h2>
        <span className="lh-card-meta">
          Monte-Carlo over the USD-quoted positions of this portfolio
        </span>
      </header>

      {modelsError ? (
        <p className="lh-error-text" role="alert" style={{ marginTop: "1rem" }}>
          {modelsError}
        </p>
      ) : !models ? (
        <div
          className="lh-skeleton"
          style={{ height: "6rem", marginTop: "1rem" }}
          aria-hidden="true"
        />
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gap: "0.75rem",
              marginTop: "1.25rem",
            }}
          >
            {/* ── Model ── */}
            <div className="lh-group">
              <p className="lh-group-title">Model</p>
              <div
                style={{
                  display: "grid",
                  gap: "0.75rem",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
                }}
              >
                <div className="lh-field">
                  <label className="lh-label" htmlFor="sim-model">
                    Path model
                  </label>
                  <select
                    id="sim-model"
                    className="lh-select"
                    value={modelId}
                    disabled={running}
                    onChange={(e) => selectModel(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lh-field">
                  <label className="lh-label" htmlFor="sim-window">
                    Calibration window
                  </label>
                  <select
                    id="sim-window"
                    className="lh-select"
                    value={windowDays}
                    disabled={running}
                    onChange={(e) =>
                      setWindowDays(Number(e.target.value) as SimWindowDays)
                    }
                  >
                    {WINDOW_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {selectedModel && (
                <div style={{ marginTop: "0.75rem" }}>
                  <SchemaConfigForm
                    key={selectedModel.id}
                    schema={selectedModel.configSchema}
                    config={config}
                    onChange={setConfig}
                    disabled={running}
                  />
                </div>
              )}
            </div>

            {/* ── Horizon ── */}
            <div className="lh-group">
              <p className="lh-group-title">Horizon</p>
              <div className="lh-field">
                <label className="lh-label" htmlFor="sim-horizon">
                  {horizonWeeks} week{horizonWeeks === 1 ? "" : "s"} ·{" "}
                  {horizonWeeks * 7} daily steps
                </label>
                <input
                  id="sim-horizon"
                  className="lh-slider"
                  type="range"
                  min={1}
                  max={52}
                  step={1}
                  value={horizonWeeks}
                  disabled={running}
                  onChange={(e) => setHorizonWeeks(Number(e.target.value))}
                />
              </div>
            </div>

            {/* ── Cross-asset sampling ── */}
            <div className="lh-group">
              <p className="lh-group-title">Cross-asset sampling</p>
              <div
                role="radiogroup"
                aria-label="How several assets are sampled together"
                className="lh-seg"
              >
                {(
                  [
                    { value: "joint" as const, label: "Joint" },
                    { value: "independent" as const, label: "Independent" },
                  ]
                ).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={sampling === o.value}
                    disabled={running}
                    onClick={() => setSampling(o.value)}
                    className="lh-seg-btn"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="lh-note" style={{ marginTop: "0.6rem" }}>
                {sampling === "joint" ? (
                  <>
                    One resampled history is read across every asset, so the
                    paths carry the correlation the market actually showed —
                    for prices and for fee income alike. Correlation is
                    applied with its sign: assets that move together widen
                    the outcome spread, assets that move against each other
                    narrow it. This is the correct setting for portfolio
                    risk.
                  </>
                ) : (
                  <>
                    <b>Diagnostic only.</b> Each asset is drawn from its own
                    distribution with an independent seed, discarding the
                    measured correlation. Read it <em>against</em> the joint
                    result — the gap between the two is what correlation is
                    worth to this portfolio. It is not a risk figure on its
                    own: for positively correlated assets it understates the
                    tail, and it credits diversification the portfolio may
                    not have.
                  </>
                )}
              </p>

              <label
                className="lh-check"
                style={{ marginTop: "0.75rem", display: "block" }}
              >
                <input
                  type="checkbox"
                  checked={compareSampling}
                  disabled={running}
                  onChange={(e) => setCompareSampling(e.target.checked)}
                />{" "}
                Measure the co-movement effect
              </label>
              <p className="lh-note" style={{ marginTop: "0.4rem" }}>
                Runs the portfolio both ways and reports the difference, so
                the diversification your correlation actually buys is a
                number rather than an inference. Doubles the simulation, and
                applies only when more than one asset is held.
              </p>
            </div>

            {/* ── Composition ── */}
            <div className="lh-group">
              <p className="lh-group-title">Composition</p>
              <div
                role="radiogroup"
                aria-label="Which component the report describes"
                className="lh-seg"
              >
                {COMPOSITION_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={composition === o.value}
                    disabled={running}
                    onClick={() => setComposition(o.value)}
                    className="lh-seg-btn"
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              {composition !== "value" && (
                <div
                  style={{
                    display: "grid",
                    gap: "0.85rem",
                    marginTop: "0.85rem",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
                  }}
                >
                  <div className="lh-field">
                    <label className="lh-label" htmlFor="sim-fee-rate">
                      Fee rate override — %/day, in-range
                    </label>
                    <input
                      id="sim-fee-rate"
                      className="lh-input lh-input-mono"
                      type="number"
                      min={0}
                      max={5}
                      step={0.01}
                      value={feeRateOverride}
                      placeholder="measured"
                      disabled={running}
                      onChange={(e) => setFeeRateOverride(e.target.value)}
                    />
                    <p className="lh-help">
                      Leave empty to use the measured rate. This is the rate
                      WHILE in range — the simulation applies your range
                      occupancy path by path.
                    </p>
                  </div>
                  <div className="lh-field">
                    <label className="lh-check">
                      <input
                        type="checkbox"
                        checked={stochasticFee}
                        disabled={running}
                        onChange={(e) => setStochasticFee(e.target.checked)}
                      />
                      Model volume fluctuations (stochastic fee intensity)
                    </label>
                    <p className="lh-help">
                      Resamples the pool&apos;s historical daily volume shape
                      (Birdeye pool volume, block bootstrap), so the fee rate
                      fluctuates along each path. The level stays anchored to
                      the measured rate — or to your override, with history
                      setting only the fluctuations.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* ── Advanced ── */}
            <details className="lh-disclosure">
              <summary>
                Advanced — paths, seed, hedge overlay
                {(nPaths !== 2000 || seed !== 42 || hedged) && " · changed"}
              </summary>
              <div className="lh-disclosure-body">
                <div
                  style={{
                    display: "grid",
                    gap: "0.85rem",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
                  }}
                >
                  <div className="lh-field">
                    <label className="lh-label" htmlFor="sim-paths">
                      Paths (100–5000)
                    </label>
                    <input
                      id="sim-paths"
                      className="lh-input lh-input-mono"
                      type="number"
                      min={100}
                      max={5000}
                      step={100}
                      value={nPaths}
                      disabled={running}
                      onChange={(e) => setNPaths(Number(e.target.value))}
                    />
                  </div>
                  <div className="lh-field">
                    <label className="lh-label" htmlFor="sim-seed">
                      Seed
                    </label>
                    <input
                      id="sim-seed"
                      className="lh-input lh-input-mono"
                      type="number"
                      step={1}
                      value={seed}
                      disabled={running}
                      onChange={(e) => setSeed(Number(e.target.value))}
                    />
                    <p className="lh-help">
                      The same seed with the same configuration reproduces a run
                      exactly.
                    </p>
                  </div>
                  <div className="lh-field">
                    <label className="lh-check">
                      <input
                        type="checkbox"
                        checked={hedged}
                        disabled={running}
                        onChange={(e) => setHedged(e.target.checked)}
                      />
                      Hedged — a Liquidity Hedge certificate held to horizon
                    </label>
                    {hedged && (
                      <>
                        <label
                          className="lh-label"
                          htmlFor="sim-premium"
                          style={{ marginTop: "0.4rem" }}
                        >
                          Premium per certificate, USD
                        </label>
                        <input
                          id="sim-premium"
                          className="lh-input lh-input-mono"
                          type="number"
                          min={0}
                          step={0.01}
                          value={premiumUsd}
                          disabled={running}
                          onChange={(e) =>
                            setPremiumUsd(Math.max(0, Number(e.target.value)))
                          }
                        />
                        <p className="lh-help">
                          Enter a quoted premium. A live quote for a specific
                          position comes from that position&rsquo;s hedge panel.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </details>
          </div>

          <div className="lh-btn-row" style={{ marginTop: "1.25rem" }}>
            <button
              type="button"
              className="lh-btn"
              onClick={run}
              disabled={running || !modelId}
            >
              {running ? "Simulating…" : "Run simulation"}
            </button>
            {running && (
              <span className="lh-help" role="status">
                Running {nPaths.toLocaleString("en-US")} paths over{" "}
                {horizonWeeks * 7} daily steps…
              </span>
            )}
          </div>

          {retryAtTs !== null ? (
            <div style={{ marginTop: "0.85rem" }}>
              <RateLimitNotice
                retryAtTs={retryAtTs}
                what="Simulation runs"
                onRetry={run}
              />
            </div>
          ) : (
            runError && (
              <p
                className="lh-error-text"
                role="alert"
                style={{ marginTop: "0.85rem" }}
              >
                {runError}
              </p>
            )
          )}

          {/* Results — previous render held at reduced opacity on re-run */}
          {result && report && (
            <div
              className={`lh-stack${running ? " lh-dim" : ""}`}
              style={{ marginTop: "1.5rem" }}
              aria-busy={running}
            >
              <div className="lh-card-head">
                <p className="lh-label-block">
                  {reportComposition === "yield"
                    ? "Accrued-fees fan"
                    : "Portfolio value fan"}{" "}
                  — {result.positionsCount} position
                  {result.positionsCount === 1 ? "" : "s"}
                  {result.assets && result.assets.length > 1
                    ? ` across ${result.assets.length} assets, drawn ${
                        result.sampling === "independent"
                          ? "independently (correlation discarded)"
                          : "jointly"
                      }`
                    : ""}
                  , initial {formatUsd(report.initialValue)}
                </p>
                <span className="lh-card-meta">
                  {result.echo.modelId} · seed {result.echo.seed} ·{" "}
                  {result.executedPaths.toLocaleString("en-US")} paths
                  {result.executedPaths !== result.echo.nPaths
                    ? ` (of ${result.echo.nPaths.toLocaleString("en-US")} requested — this model is capped by available history)`
                    : ""}{" "}
                  ·{" "}
                  {result.echo.windowDays}d window
                </span>
              </div>

              {/* Correlation, with its uncertainty. The joint simulator's
                  claim rests on this estimate, so it is shown rather than
                  assumed — and shown with a CI, because a coefficient
                  without one is a guess with a decimal point. */}
              {result.correlation && result.correlation.assetIds.length > 1 && (
                <details className="lh-details" style={{ marginTop: "1rem" }}>
                  <summary>
                    Return correlation — {result.correlation.assetIds.length}{" "}
                    assets, n={result.correlation.n} daily observations
                  </summary>
                  <div
                    className="lh-table-scroll"
                    role="region"
                    aria-label="Return correlation matrix"
                    tabIndex={0}
                    style={{ marginTop: "0.75rem" }}
                  >
                    <table className="lh-table">
                      <caption>
                        Pearson correlation of aligned daily log returns
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Asset</th>
                          {result.correlation.assetIds.map((id) => (
                            <th key={id} scope="col">
                              {shortMint(id)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.correlation.matrix.map((row, i) => (
                          <tr key={result.correlation!.assetIds[i]}>
                            <th scope="row">
                              {shortMint(result.correlation!.assetIds[i])}
                            </th>
                            {row.map((v, j) => (
                              <td key={j} className="lh-td-num">
                                {i === j ? "1" : v.toFixed(3)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div
                    className="lh-table-scroll"
                    role="region"
                    aria-label="Correlation significance"
                    tabIndex={0}
                    style={{ marginTop: "0.75rem" }}
                  >
                    <table className="lh-table">
                      <caption>
                        95% confidence interval and two-sided p-value against
                        no correlation
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Pair</th>
                          <th scope="col">r</th>
                          <th scope="col">95% CI</th>
                          <th scope="col">p</th>
                          <th scope="col">Significant</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.correlation.pairs.map((pr) => (
                          <tr key={`${pr.i}-${pr.j}`}>
                            <th scope="row">
                              {shortMint(result.correlation!.assetIds[pr.i])} ·{" "}
                              {shortMint(result.correlation!.assetIds[pr.j])}
                            </th>
                            <td className="lh-td-num">{pr.r.toFixed(3)}</td>
                            <td className="lh-td-num">
                              [{pr.ciLow.toFixed(3)}, {pr.ciHigh.toFixed(3)}]
                            </td>
                            <td className="lh-td-num">
                              {pr.pValue < 0.001
                                ? "<0.001"
                                : pr.pValue.toFixed(3)}
                            </td>
                            <td>{pr.significant ? "yes" : "no"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {result.comovement && (
                    <div
                      className="lh-table-scroll"
                      role="region"
                      aria-label="Co-movement effect"
                      tabIndex={0}
                      style={{ marginTop: "0.75rem" }}
                    >
                      <table className="lh-table">
                        <caption>
                          Co-movement effect — the same portfolio priced both
                          ways
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Measure</th>
                            <th scope="col">Joint</th>
                            <th scope="col">Independent</th>
                            <th scope="col">Effect</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <th scope="row">Terminal P&amp;L spread (σ)</th>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.jointStd)}
                            </td>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.independentStd)}
                            </td>
                            <td className="lh-td-num">
                              ×{result.comovement.dispersionRatio.toFixed(3)}
                            </td>
                          </tr>
                          <tr>
                            <th scope="row">5% worst case (VaR)</th>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.jointVar5)}
                            </td>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.independentVar5)}
                            </td>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.var5DeltaUsd)}
                            </td>
                          </tr>
                          <tr>
                            <th scope="row">Mean of worst 5% (CVaR)</th>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.jointCvar5)}
                            </td>
                            <td className="lh-td-num">
                              {formatUsd(result.comovement.independentCvar5)}
                            </td>
                            <td className="lh-td-num">
                              {formatUsd(
                                result.comovement.jointCvar5 -
                                  result.comovement.independentCvar5,
                              )}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {result.comovement && (
                    <p className="lh-note" style={{ marginTop: "0.5rem" }}>
                      {result.comovement.dispersionRatio > 1.005 ? (
                        <>
                          Correlation <b>widens</b> this portfolio&rsquo;s
                          outcome spread by{" "}
                          {(
                            (result.comovement.dispersionRatio - 1) *
                            100
                          ).toFixed(1)}
                          %. The assets move together, so holding several of
                          them diversifies less than their individual
                          volatilities suggest.
                        </>
                      ) : result.comovement.dispersionRatio < 0.995 ? (
                        <>
                          Correlation <b>narrows</b> this portfolio&rsquo;s
                          outcome spread by{" "}
                          {(
                            (1 - result.comovement.dispersionRatio) *
                            100
                          ).toFixed(1)}
                          %. The assets partly offset each other — a genuine
                          diversification benefit, earned rather than assumed.
                        </>
                      ) : (
                        <>
                          Correlation makes no material difference to this
                          portfolio&rsquo;s spread — the measured co-movement
                          is too weak, or the positions too concentrated in
                          one asset, for it to matter.
                        </>
                      )}
                    </p>
                  )}

                  <p className="lh-note" style={{ marginTop: "0.75rem" }}>
                    {result.correlation.method}
                  </p>
                  {result.sampling === "independent" && (
                    <p className="lh-note" style={{ marginTop: "0.5rem" }}>
                      <b>These results ignore the correlation above.</b>{" "}
                      Sampling was set to independent, so the dispersion shown
                      assumes a diversification benefit the portfolio does not
                      have. Compare against a joint run before using any
                      number from it.
                    </p>
                  )}
                </details>
              )}

              {/* Provenance: in-range behaviour in these results is a
                  property of the chosen path model, not of the portfolio
                  card's in-range estimator. */}
              <p className="lh-prov">
                <span className="lh-prov-item">
                  <span className="lh-prov-key">in-range dynamics</span>
                  implied by{" "}
                  {models.find((m) => m.id === result.echo.modelId)?.label ??
                    result.echo.modelId}{" "}
                  paths — each simulation mode produces its own in-range
                  behaviour by construction
                </span>
                {result.assets && result.assets.length > 1 && (
                  <span className="lh-prov-item">
                    <span className="lh-prov-key">fee accrual</span>
                    modelled per pool as a USD rate on position value,
                    calibrated on that pool&rsquo;s own volume history and
                    marked along its own asset&rsquo;s path — the token split
                    of accrued fees between the pair is not tracked, so
                    uncollected fees carry no separate inventory exposure
                  </span>
                )}
              </p>

              <FanChart
                fan={report.fan}
                // Yield-only series starts from zero accrued fees — the
                // position's value is not on this axis.
                initialValue={
                  reportComposition === "yield" ? 0 : report.initialValue
                }
                yCaption={COMPOSITION_Y_CAPTION[reportComposition]}
              />

              <div
                style={{
                  display: "grid",
                  gap: "1rem",
                  gridTemplateColumns: report.hedgedTerminal
                    ? "repeat(auto-fit, minmax(min(100%, 26rem), 1fr))"
                    : "minmax(0, 1fr)",
                }}
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

              {/* Yield provenance: accrued mean + the rate actually used */}
              {reportComposition !== "value" && rateSource && (
                <p className="lh-prov">
                  <span className="lh-prov-item">
                    <span className="lh-prov-key">mean accrued</span>
                    {formatUsd(report.meanAccruedYieldUsd)} over the horizon
                  </span>
                  <span className="lh-prov-item">
                    <span className="lh-prov-key">rate</span>
                    {rateSource}
                  </span>
                </p>
              )}

              <div className="lh-facts lh-facts-3">
                <Fact
                  label="Max drawdown (median)"
                  value={formatUsd(report.maxDrawdown.p50)}
                />
                <Fact
                  label="Max drawdown (p95)"
                  value={formatUsd(report.maxDrawdown.p95)}
                />
                <Fact
                  label="P(exit range)"
                  value={formatPercent(report.pExitRange)}
                  sub="any position, any step"
                />
              </div>

              <p className="lh-note">
                Hypothetical simulation — model output, not a prediction and not
                investment advice.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
