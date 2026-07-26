"use client";

/**
 * One card per Orca Whirlpool position: pair, in-range status, range vs
 * current price, holdings, value, checkpointed fees and the V(S) chart.
 */

import type {
  PortfolioPositionWire,
  PositionViabilityWire,
} from "@/lib/portfolio-api";
import {
  formatNumber,
  formatTokenAmount,
  formatUsd,
  pairLabel,
  shortenAddress,
  tokenLabel,
} from "@/lib/format";
import { ValueCurveChart } from "@/components/value-curve-chart";
import { HedgePanel } from "@/components/hedge-panel";
import { SOL_MINT } from "@/lib/hedge-api";

function InRangeBadge({ inRange }: { inRange: boolean }) {
  // Status = dot (color) + label (text token): never color alone.
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium dark:border-zinc-700"
      style={{
        backgroundColor: inRange
          ? "rgba(12, 163, 12, 0.10)"
          : "rgba(250, 178, 25, 0.12)",
      }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{
          backgroundColor: inRange ? "var(--status-good)" : "var(--status-warning)",
        }}
      />
      {inRange ? "In range" : "Out of range"}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

/** Small hover/focus info tip — keyboard reachable, title-based. */
function InfoTip({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-300 text-[10px] leading-none text-zinc-500 dark:border-zinc-600 dark:text-zinc-400"
      title={text}
      aria-label={text}
      role="note"
    >
      i
    </span>
  );
}

/** "0.000412" (per day) → "0.041%/day" */
function formatDailyYield(v: number): string {
  const pct = v * 100;
  const decimals = pct >= 0.1 ? 2 : 3;
  return `${pct.toFixed(decimals)}%/day`;
}

/**
 * Viability band: threshold label + reserved status color, never color
 * alone (the label carries the meaning; the dot reinforces it).
 */
function viabilityBand(vi: number | null): {
  label: string;
  color: string;
  wash: string;
} {
  // null encodes Infinity (zero breakeven — fees trivially cover the cost).
  if (vi === null || vi >= 1) {
    return {
      label: "fees cover hedge cost",
      color: "var(--status-good)",
      wash: "rgba(12, 163, 12, 0.10)",
    };
  }
  if (vi >= 0.5) {
    return {
      label: "partial fee coverage",
      color: "var(--status-warning)",
      wash: "rgba(250, 178, 25, 0.12)",
    };
  }
  return {
    label: "fees well below hedge cost",
    color: "var(--status-critical)",
    wash: "rgba(208, 59, 59, 0.10)",
  };
}

/** "0.55" → "55%" (fractions of time in range). */
function formatFraction(f: number): string {
  return `${(f * 100).toFixed(0)}%`;
}

/**
 * Estimator transparency line (policy 2026-07-08): states VERBATIM which
 * estimator produced the in-range fraction. Empirical shows its window
 * count + uncertainty band; the GBM fallback shows sigma + why the
 * empirical estimator was unavailable. The info tip carries the
 * estimate's own description verbatim, plus the side-by-side comparison
 * when the reference estimator exists.
 */
function EstimatorLine({ viability }: { viability: PositionViabilityWire }) {
  const est = viability.inRangeEstimate;
  const empirical = est.method === "empirical";

  const tipText =
    est.reference !== null
      ? `${est.description}\n\nEmpirical ${formatFraction(est.fraction)} vs GBM ${formatFraction(est.reference.fraction)}`
      : est.description;

  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
      <span>
        {empirical
          ? `estimator: empirical (${viability.empiricalWindows ?? "?"} windows)`
          : `estimator: GBM model (σ ${(viability.sigmaAnnualized * 100).toFixed(0)}%)`}
      </span>
      {empirical && est.band && (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          in-range {viability.tenorDays}d: {formatFraction(est.fraction)} (p05{" "}
          {formatFraction(est.band.p05)} – p95 {formatFraction(est.band.p95)})
        </span>
      )}
      <InfoTip text={tipText} />
      {est.modelRiskFlag && est.divergence !== null && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          style={{ backgroundColor: "rgba(250, 178, 25, 0.12)" }}
          title={`The measured in-range time differs from the pricing model's assumption by ${(est.divergence * 100).toFixed(0)}% — treat model-based numbers with caution.`}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "var(--status-warning)" }}
          />
          model divergence
        </span>
      )}
      {!empirical && est.fallbackReason && (
        <span className="text-zinc-400 dark:text-zinc-500">
          empirical unavailable: {est.fallbackReason}
        </span>
      )}
    </div>
  );
}

function ViabilityRow({ viability }: { viability: PositionViabilityWire | null }) {
  if (!viability) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-2 dark:border-zinc-700">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Viability index
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          viability unavailable
        </span>
        <InfoTip text="The Viability Index needs live market data (Birdeye pool volume and OHLCV). When that data is missing or degraded the index is omitted rather than estimated." />
      </div>
    );
  }

  const vi = viability.viabilityIndex;
  const band = viabilityBand(vi);
  const viLabel = vi === null ? "∞" : vi.toFixed(2);

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        Viability index ({viability.tenorDays}d hedge)
      </span>
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium dark:border-zinc-700"
        style={{ backgroundColor: band.wash }}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: band.color }}
        />
        VI {viLabel} — {band.label}
      </span>
      <span
        className="text-xs text-zinc-500 dark:text-zinc-400"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        measured {formatDailyYield(viability.measuredDailyYield)} vs breakeven{" "}
        {formatDailyYield(viability.breakevenDailyYield)}
      </span>
      <InfoTip
        text={`Model-based estimate (corridor breakeven; see product-design docs). Breakeven is ${viability.bound}-bound from a seeded Monte-Carlo fair value of the 7-day corridor payoff at sigma ${(viability.sigmaAnnualized * 100).toFixed(1)}% (${viability.sigmaWindowDays}d realized vol). Measured yield = Birdeye pool fee yield x in-range fraction ${viability.inRangeFraction.toFixed(2)} x concentration factor ${viability.concentrationFactor.toFixed(2)}. Not a prediction.`}
      />
      <EstimatorLine viability={viability} />
    </div>
  );
}

export function PositionCard({
  position,
  owner,
}: {
  position: PortfolioPositionWire;
  owner: string;
}) {
  const pair = pairLabel(position.tokenMintA, position.tokenMintB);
  const symbolA = tokenLabel(position.tokenMintA);
  const symbolB = tokenLabel(position.tokenMintB);
  // Hedge eligibility: SOL/USDC pair, currently in range (FR-H1).
  const hedgeable =
    position.tokenMintA === SOL_MINT && position.isUsdcQuoted && position.inRange;

  return (
    <article className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold tracking-tight">{pair}</h3>
          <InRangeBadge inRange={position.inRange} />
        </div>
        <span
          className="font-mono text-xs text-zinc-500 dark:text-zinc-400"
          title={position.positionAddress}
        >
          {shortenAddress(position.positionAddress)}
        </span>
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Price range">
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatNumber(position.priceLower)} – {formatNumber(position.priceUpper)}
          </span>
        </Fact>
        <Fact label="Current price">
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatNumber(position.price)} {symbolB}
          </span>
        </Fact>
        <Fact label="Holdings">
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatTokenAmount(position.amountA, position.decimalsA)} {symbolA}
            <span className="text-zinc-400 dark:text-zinc-500"> + </span>
            {formatTokenAmount(position.amountB, position.decimalsB)} {symbolB}
          </span>
        </Fact>
        <Fact label="Position value">
          <span className="font-semibold">
            {position.isUsdcQuoted
              ? formatUsd(position.valueQuote)
              : `${formatNumber(position.valueQuote)} ${symbolB}`}
          </span>
          {!position.isUsdcQuoted && (
            <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">
              (non-USDC quote)
            </span>
          )}
        </Fact>
        <Fact label="Fees owed (on-chain checkpoint, lower bound)">
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatTokenAmount(position.feeOwedA, position.decimalsA)} {symbolA}
            <span className="text-zinc-400 dark:text-zinc-500"> + </span>
            {formatTokenAmount(position.feeOwedB, position.decimalsB)} {symbolB}
          </span>
        </Fact>
      </dl>

      <ViabilityRow viability={position.viability} />

      <div className="mt-5">
        <h4 className="text-xs text-zinc-500 dark:text-zinc-400">
          Position value V(S) vs price — shaded band is the active range
        </h4>
        <div className="mt-2">
          <ValueCurveChart
            curve={position.curve}
            price={position.price}
            priceLower={position.priceLower}
            priceUpper={position.priceUpper}
            isUsdcQuoted={position.isUsdcQuoted}
            quoteSymbol={symbolB}
            pair={pair}
          />
        </div>
      </div>

      {hedgeable && <HedgePanel owner={owner} position={position} />}
    </article>
  );
}
