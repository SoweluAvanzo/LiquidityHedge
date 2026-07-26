"use client";

/**
 * One card per Orca Whirlpool position: pair, in-range status, range vs
 * current price, holdings, value, checkpointed fees and the V(S) chart.
 *
 * Every model-derived number keeps its provenance line — which estimator,
 * over which window, with which uncertainty band. The line is set small,
 * monospace and secondary, but it is never removed.
 */

import type {
  PortfolioPositionWire,
  PositionViabilityWire,
} from "@/lib/portfolio-api";
import {
  formatDailyYield,
  formatFraction,
  formatNumber,
  formatPercent,
  formatTokenAmount,
  formatUsd,
  pairLabel,
  shortenAddress,
  tokenLabel,
} from "@/lib/format";
import { ValueCurveChart } from "@/components/value-curve-chart";
import { HedgePanel } from "@/components/hedge-panel";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { InfoTip } from "@/components/ui/info-tip";
import { SOL_MINT } from "@/lib/hedge-api";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Viability band: threshold label + reserved status tone, never colour
 * alone (the label carries the meaning; the dot reinforces it).
 */
function viabilityBand(vi: number | null): { label: string; tone: StatusTone } {
  // null encodes Infinity (zero breakeven — fees trivially cover the cost).
  if (vi === null || vi >= 1) {
    return { label: "fees cover hedge cost", tone: "good" };
  }
  if (vi >= 0.5) {
    return { label: "partial fee coverage", tone: "warning" };
  }
  return { label: "fees well below hedge cost", tone: "critical" };
}

/**
 * Estimator provenance (policy 2026-07-08): states VERBATIM which
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
    <p className="lh-prov">
      <span className="lh-prov-item">
        <span className="lh-prov-key">estimator</span>
        {empirical
          ? `empirical (${viability.empiricalWindows ?? "?"} windows)`
          : `GBM model (σ ${formatPercent(viability.sigmaAnnualized, 0)})`}
      </span>
      {empirical && est.band && (
        <span className="lh-prov-item">
          <span className="lh-prov-key">in range {viability.tenorDays}d</span>
          {formatFraction(est.fraction)} (p05 {formatFraction(est.band.p05)} –
          p95 {formatFraction(est.band.p95)})
        </span>
      )}
      <InfoTip text={tipText} />
      {est.modelRiskFlag && est.divergence !== null && (
        <StatusBadge
          tone="warning"
          label="model divergence"
          title={`The measured in-range time differs from the pricing model's assumption by ${formatPercent(est.divergence, 0)} — treat model-based numbers with caution.`}
        />
      )}
      {!empirical && est.fallbackReason && (
        <span className="lh-prov-item">
          <span className="lh-prov-key">empirical unavailable</span>
          {est.fallbackReason}
        </span>
      )}
    </p>
  );
}

function ViabilityRow({
  viability,
}: {
  viability: PositionViabilityWire | null;
}) {
  if (!viability) {
    return (
      <div className="lh-card-sub lh-card-dashed" style={{ marginTop: "1rem" }}>
        <p className="lh-prov">
          <span className="lh-prov-key">viability index</span>
          <span>unavailable</span>
          <InfoTip text="The Viability Index needs live market data (Birdeye pool volume and OHLCV). When that data is missing or degraded the index is omitted rather than estimated." />
        </p>
      </div>
    );
  }

  const vi = viability.viabilityIndex;
  const band = viabilityBand(vi);
  const viLabel = vi === null ? "∞" : vi.toFixed(2);

  return (
    <div className="lh-card-sub" style={{ marginTop: "1rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.4rem 0.9rem",
        }}
      >
        <span className="lh-label">
          Viability index ({viability.tenorDays}d hedge)
        </span>
        <StatusBadge tone={band.tone} label={`VI ${viLabel} — ${band.label}`} />
        <span className="lh-prov">
          <span className="lh-prov-item">
            <span className="lh-prov-key">measured</span>
            {formatDailyYield(viability.measuredDailyYield)}
          </span>
          <span className="lh-prov-item">
            <span className="lh-prov-key">model breakeven</span>
            {formatDailyYield(viability.breakevenDailyYield)}
          </span>
          <InfoTip
            text={`Model-based estimate (range breakeven; see product-design docs). Breakeven is ${viability.bound}-bound from a seeded Monte-Carlo fair value of the 7-day range payoff at sigma ${formatPercent(viability.sigmaAnnualized, 1)} (${viability.sigmaWindowDays}d realized vol). Measured yield = Birdeye pool fee yield x in-range fraction ${viability.inRangeFraction.toFixed(2)} x concentration factor ${viability.concentrationFactor.toFixed(2)}. Not a prediction.`}
          />
        </span>
      </div>
      <div style={{ marginTop: "0.4rem" }}>
        <EstimatorLine viability={viability} />
      </div>
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
    position.tokenMintA === SOL_MINT &&
    position.isUsdcQuoted &&
    position.inRange;

  return (
    <article className="lh-card">
      <header className="lh-card-head">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <h2 className="lh-h2">{pair}</h2>
          <StatusBadge
            tone={position.inRange ? "good" : "warning"}
            label={position.inRange ? "In range" : "Out of range"}
          />
        </div>
        <span className="lh-card-meta" title={position.positionAddress}>
          {shortenAddress(position.positionAddress)}
        </span>
      </header>

      <dl className="lh-dl lh-dl-4" style={{ marginTop: "1.25rem" }}>
        <Fact label="Range [p_l, p_u]">
          {formatNumber(position.priceLower)} –{" "}
          {formatNumber(position.priceUpper)}
        </Fact>
        <Fact label="Current price">
          {formatNumber(position.price)} {symbolB}
        </Fact>
        <Fact label="Holdings">
          {formatTokenAmount(position.amountA, position.decimalsA)} {symbolA}
          {" + "}
          {formatTokenAmount(position.amountB, position.decimalsB)} {symbolB}
        </Fact>
        <Fact label="Position value">
          <b>
            {position.isUsdcQuoted
              ? formatUsd(position.valueQuote)
              : `${formatNumber(position.valueQuote)} ${symbolB}`}
          </b>
          {!position.isUsdcQuoted && (
            <span className="lh-help"> (non-USDC quote)</span>
          )}
        </Fact>
        <Fact label="Fees owed — on-chain checkpoint, lower bound">
          {formatTokenAmount(position.feeOwedA, position.decimalsA)} {symbolA}
          {" + "}
          {formatTokenAmount(position.feeOwedB, position.decimalsB)} {symbolB}
        </Fact>
      </dl>

      <ViabilityRow viability={position.viability} />

      <div style={{ marginTop: "1.5rem" }}>
        <p className="lh-label-block">
          Position value V(S) vs price — shaded band is the range [p_l, p_u]
        </p>
        <div style={{ marginTop: "0.5rem" }}>
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
