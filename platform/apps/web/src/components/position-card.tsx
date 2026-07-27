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

type IndexBand = { p05: number; p95: number | null } | null;

/**
 * §1.7 verdict with a CI dead-band: a verdict is asserted only when the
 * WHOLE 90% band clears the threshold — a small price move inside the
 * band can no longer flip the badge (the measured pathology: mGADEK
 * crossed VI = 1 on a 12-minute, 0.17% move). Band-straddling states
 * are labelled borderline instead of pretending resolution. Threshold
 * label + reserved status tone, never colour alone.
 */
function bandedVerdict(
  vi: number | null,
  band: IndexBand,
  labels: { good: string; partial: string; critical: string },
): { label: string; tone: StatusTone } {
  // null encodes Infinity (zero breakeven — trivially covered).
  if (vi === null) return { label: labels.good, tone: "good" };
  if (band) {
    const hi = band.p95; // null = unbounded above
    if (band.p05 >= 1) return { label: labels.good, tone: "good" };
    if (hi !== null && hi < 0.5) return { label: labels.critical, tone: "critical" };
    if (hi === null || hi >= 1) {
      return { label: `${labels.partial} — borderline (interval spans breakeven)`, tone: "warning" };
    }
    if (band.p05 < 0.5) {
      return { label: `${labels.partial} — borderline`, tone: "warning" };
    }
    return { label: labels.partial, tone: "warning" };
  }
  // No band available — point-threshold fallback (pre-§1.7 behaviour).
  if (vi >= 1) return { label: labels.good, tone: "good" };
  if (vi >= 0.5) return { label: labels.partial, tone: "warning" };
  return { label: labels.critical, tone: "critical" };
}

const VI1_LABELS = {
  good: "fees cover hedge cost",
  partial: "partial fee coverage",
  critical: "fees well below hedge cost",
};

/** Different wording on purpose: the two-sided index is about whether
 *  PROVIDING THE LIQUIDITY pays once divergence loss is counted, not
 *  whether fees cover the hedge's markup. */
const VI2_LABELS = {
  good: "fees cover divergence loss",
  partial: "partially covers divergence loss",
  critical: "fees below divergence loss",
};

/** "VI 0.59 [0.31–0.94]" — the band IS the resolution statement. */
function viWithBand(vi: number | null, band: IndexBand): string {
  const point = vi === null ? "∞" : vi.toFixed(2);
  if (!band) return point;
  return `${point} [${band.p05.toFixed(2)}–${band.p95 === null ? "∞" : band.p95.toFixed(2)}]`;
}

/**
 * §1.1 pool-yield provenance for the methodology tooltip: measured from
 * our own on-chain fee-growth snapshots, or the labelled Birdeye
 * fallback — a modelled number must never read as a measurement.
 */
function poolYieldLabel(viability: PositionViabilityWire): string {
  const py = viability.poolYield;
  if (py && py.source === "measured-snapshots") {
    const hours =
      py.coveredSeconds !== null ? (py.coveredSeconds / 3600).toFixed(1) : "?";
    return `pool fee yield measured from on-chain fee-growth snapshots (${hours}h window)`;
  }
  return "Birdeye-modelled pool fee yield (snapshot history unavailable)";
}

/**
 * §1.2: how the measured legs of measuredDailyYield were produced — the
 * position's own realised in-range intensity, or the modelled
 * pool-rate × concentration chain. The in-range fraction is the FORWARD
 * estimate on both paths (a trailing occupancy would credit a position
 * that left its range with its historic yield).
 */
function measuredYieldMethodology(viability: PositionViabilityWire): string {
  const pos = viability.positionYield;
  if (pos && pos.source === "realised-inside") {
    const inRangeH =
      pos.inRangeSeconds !== null ? (pos.inRangeSeconds / 3600).toFixed(1) : "?";
    const fees = pos.feesUsd !== null ? `$${pos.feesUsd.toFixed(4)}` : "?";
    return `Estimated yield = the position's own realised in-range fee intensity (${fees} earned over ${inRangeH}h in range, from its feeGrowthInside accumulator) x forward in-range fraction ${viability.inRangeFraction.toFixed(2)} — concentration and fee competition measured, occupancy still an estimate`;
  }
  return `Estimated yield = ${poolYieldLabel(viability)} x in-range fraction ${viability.inRangeFraction.toFixed(2)} x concentration factor ${viability.concentrationFactor.toFixed(2)}`;
}

/** Honest prov key: "measured" only when the measured legs really are
 *  the position's own accumulator; the modelled chain says so. */
function yieldProvKey(viability: PositionViabilityWire): string {
  return viability.positionYield?.source === "realised-inside"
    ? "measured"
    : "est. (model)";
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

  const outcomeSpread = est.band
    ? `\n\nSingle-window outcome spread (not estimate precision): p05 ${formatFraction(est.band.p05)} – p95 ${formatFraction(est.band.p95)}.`
    : "";
  const tipText =
    est.reference !== null
      ? `${est.description}${outcomeSpread}\n\nEmpirical ${formatFraction(est.fraction)} vs GBM ${formatFraction(est.reference.fraction)}`
      : est.description;

  const py = viability.poolYield;
  return (
    <p className="lh-prov">
      <span className="lh-prov-item">
        <span className="lh-prov-key">estimator</span>
        {empirical
          ? `empirical (${viability.empiricalWindows ?? "?"} windows)`
          : `GBM model (σ ${formatPercent(viability.sigmaAnnualized, 0)})`}
      </span>
      {viability.sigmaBand && (
        <span className="lh-prov-item">
          <span className="lh-prov-key">
            σ ({viability.sigmaWindowDays}d{" "}
            {viability.sigmaMethod === "garman-klass" ? "GK-OHLC" : "close-to-close"}
            {viability.sigmaTenorAdjust
              ? ` × ${viability.sigmaTenorAdjust.ratio.toFixed(2)} tenor-adj`
              : ""}
            )
          </span>
          {formatPercent(viability.sigmaAnnualized, 1)} (90% CI{" "}
          {formatPercent(viability.sigmaBand.p05, 1)}–
          {formatPercent(viability.sigmaBand.p95, 1)})
          <InfoTip
            text={
              viability.sigmaTenorAdjust
                ? `The 7-day payoff depends on tenor-scale dispersion. Measured over 1y: weekly non-overlapping vol ${formatPercent(viability.sigmaTenorAdjust.weeklySigma1y, 1)} (n=${viability.sigmaTenorAdjust.weeklyN}) vs daily-annualised ${formatPercent(viability.sigmaTenorAdjust.dailySigma1y, 1)} — variance ratio VR(7)=${viability.sigmaTenorAdjust.varianceRatio7.toFixed(2)}: daily moves partially cancel by the week (mean reversion). The current-regime ${viability.sigmaWindowDays}d estimate (${formatPercent(viability.sigmaDaily ?? viability.sigmaAnnualized, 1)} daily-annualised) is scaled by ${viability.sigmaTenorAdjust.ratio.toFixed(2)} to the tenor scale (owner decision D5).`
                : `Daily-annualised estimate served UNADJUSTED — 1y history for the tenor-scale correction was unavailable. Under weekly mean reversion this may overstate 7-day dispersion.`
            }
          />
        </span>
      )}
      {py && (
        <span className="lh-prov-item">
          <span className="lh-prov-key">pool yield</span>
          {py.source === "measured-snapshots"
            ? `measured (${py.coveredSeconds !== null ? (py.coveredSeconds / 3600).toFixed(1) : "?"}h of snapshots)`
            : "modelled (Birdeye fallback)"}
        </span>
      )}
      {viability.positionYield && (
        <span className="lh-prov-item">
          <span className="lh-prov-key">position yield</span>
          {viability.positionYield.source === "realised-inside"
            ? `realised (${viability.positionYield.coveredSeconds !== null ? (viability.positionYield.coveredSeconds / 3600).toFixed(1) : "?"}h of own fees)`
            : "modelled (pool × in-range × concentration)"}
        </span>
      )}
      {empirical && (
        <span className="lh-prov-item">
          <span className="lh-prov-key">in range {viability.tenorDays}d</span>
          {formatFraction(est.fraction)}
          {est.meanCi
            ? ` (90% CI ${formatFraction(est.meanCi.p05)}–${formatFraction(est.meanCi.p95)}, n_eff ≈ ${est.nEffective ?? "?"})`
            : est.band
              ? ` (p05 ${formatFraction(est.band.p05)} – p95 ${formatFraction(est.band.p95)})`
              : ""}
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
  inRange,
}: {
  viability: PositionViabilityWire | null;
  inRange: boolean;
}) {
  if (!viability) {
    return (
      <div className="lh-card-sub lh-card-dashed" style={{ marginTop: "1rem" }}>
        <p className="lh-prov">
          <span className="lh-prov-key">viability index</span>
          <span>unavailable</span>
          <InfoTip text="The Viability Index needs market data: our own pool snapshots or Birdeye volume for the fee yield, and OHLCV candles for volatility. When an input is missing or degraded the index is omitted rather than estimated." />
        </p>
      </div>
    );
  }

  // §1.9 (owner decision D2b): an out-of-range position earns nothing
  // at the current price and its indices are NOT comparable to in-range
  // ones — show an explicit state instead of numbers that invite the
  // comparison. Estimator provenance stays visible; the forward
  // re-entry expectation is the one number that IS meaningful here.
  if (!inRange) {
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
          <span className="lh-label">Viability ({viability.tenorDays}d hedge)</span>
          <StatusBadge tone="warning" label="OUT OF RANGE — indices suppressed" />
          <span className="lh-prov">
            <span className="lh-prov-item">
              <span className="lh-prov-key">expected in-range time ({viability.tenorDays}d, forward)</span>
              {formatFraction(viability.inRangeFraction)}
            </span>
            <InfoTip text="The position sits outside its price range: it earns no fees at this price and a hedge here is a pure cost, so the viability indices - which assume in-range comparability - are suppressed rather than displayed next to in-range positions (decision D2). The forward in-range expectation above is the estimated share of the coming tenor the price spends back inside the range; full estimator provenance below." />
          </span>
        </div>
        <EstimatorLine viability={viability} />
      </div>
    );
  }

  const vi = viability.viabilityIndex;
  const viBand = viability.viabilityIndexBand ?? null;
  const band = bandedVerdict(vi, viBand, VI1_LABELS);
  const viLabel = viWithBand(vi, viBand);
  const ts = viability.twoSided.viabilityIndex;
  const tsBand = viability.twoSided.viabilityIndexBand ?? null;
  const tsVerdict = bandedVerdict(ts, tsBand, VI2_LABELS);
  const tsLabel = viWithBand(ts, tsBand);

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
            <span className="lh-prov-key">{yieldProvKey(viability)}</span>
            {formatDailyYield(viability.measuredDailyYield)}
          </span>
          <span className="lh-prov-item">
            <span className="lh-prov-key">model breakeven</span>
            {formatDailyYield(viability.breakevenDailyYield)}
          </span>
          {viability.uncertaintyDominatedBy && (
            <span className="lh-prov-item">
              <span className="lh-prov-key">band driver</span>
              {viability.uncertaintyDominatedBy === "sigma"
                ? "σ estimation"
                : viability.uncertaintyDominatedBy === "in-range"
                  ? "in-range sampling"
                  : "fee-flow sampling"}
            </span>
          )}
          <InfoTip
            text={`Model-based estimate (range breakeven; see product-design docs). Breakeven is ${viability.bound}-bound from a deterministic quadrature fair value of the 7-day range payoff (risk-neutral GBM) at sigma ${formatPercent(viability.sigmaAnnualized, 1)} (${viability.sigmaWindowDays}d realized vol). ${measuredYieldMethodology(viability)}. The [brackets] are a 90% interval from the quantified input uncertainties (sigma band, in-range sampling, fee-flow sampling), combined in quadrature; the verdict changes only when the whole interval clears a threshold — borderline states say so instead of flipping on small price moves. Not a prediction.`}
          />
        </span>
      </div>
      {/* Second index — the paper's two-sided breakeven (§2.4.3-2.4.4),
          which counts divergence loss. Shown ALONGSIDE, never instead:
          the two answer different questions and a reader who conflates
          them will overestimate how well the position is doing. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.4rem 0.9rem",
          marginTop: "0.5rem",
        }}
      >
        <span className="lh-label">
          Two-sided viability ({viability.tenorDays}d)
        </span>
        <StatusBadge
          tone={tsVerdict.tone}
          label={`VI ${tsLabel} — ${tsVerdict.label}`}
        />
        <span className="lh-prov">
          <span className="lh-prov-item">
            <span className="lh-prov-key">{yieldProvKey(viability)}</span>
            {formatDailyYield(viability.measuredDailyYield)}
          </span>
          <span className="lh-prov-item">
            <span className="lh-prov-key">breakeven r*</span>
            {formatDailyYield(viability.twoSided.breakevenDailyYield)}
          </span>
          <span className="lh-prov-item">
            <span className="lh-prov-key">E[ΔV] 7d (risk-neutral)</span>
            {formatUsd(viability.twoSided.expectedValueChangeUsd)}
          </span>
          {viability.driftSensitivity && (
            <span className="lh-prov-item">
              <span className="lh-prov-key">
                drift ∓{formatPercent(viability.driftSensitivity.sweepAnnual, 0)}/yr
              </span>
              {formatUsd(viability.driftSensitivity.expectedValueChangeUsdAtMinus)} …{" "}
              {formatUsd(viability.driftSensitivity.expectedValueChangeUsdAtPlus)}
            </span>
          )}
          <InfoTip
            text={`INCLUDES DIVERGENCE LOSS — this is the difference from the index above, which does not. Paper §2.4.3-2.4.4: two-sided viability needs the unhedged LP PnL to cover the protocol fee leakage, sum(dV_w + V_w*r*7) = phi*sum(P_w), giving r* = (phi*P - E[dV])/(V*T). Here E[dV] = ${formatUsd(viability.twoSided.expectedValueChangeUsd)} is the RISK-NEUTRAL expected 7-day mark-to-market change (pure divergence loss, no directional view), from the same deterministic quadrature as the fair value. The drift sweep alongside shows the same integral under a bearish/bullish physical drift — the sign and size of E[dV] are drift-determined, and the risk-neutral point is the assumption-free middle, NOT a forecast. It is also a different estimand from the paper's realised backtest dV_w (physical measure) — do not compare them directly. The unhedged breakeven (phi = 0, fees vs divergence loss alone) is ${formatDailyYield(viability.twoSided.unhedgedBreakevenDailyYield)}; the protocol-fee wedge of Corollary 2.1 adds ${formatDailyYield(viability.twoSided.protocolFeeWedgeDailyYield)} on top. Model output, not a prediction.`}
          />
        </span>
      </div>

      <p className="lh-note" style={{ marginTop: "0.5rem" }}>
        The two indices measure different things.{" "}
        <b>Viability index</b> asks only whether fee income beats the
        hedge&rsquo;s cost above fair value — it contains{" "}
        <b>no divergence-loss term</b>.{" "}
        <b>Two-sided viability</b> is the paper&rsquo;s §2.4.4 breakeven and{" "}
        <b>does count divergence loss</b>, so it is the honest test of
        whether providing the liquidity pays at all. Which of the two binds
        harder depends on the premium floor relative to position size — on a
        small position the floor dominates the first index, on a large one
        divergence loss dominates the second. Read both; neither subsumes
        the other.
      </p>

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
        <Fact
          label={
            position.feesAreExact
              ? "Fees owed — reconstructed from tick accounts, exact"
              : "Fees owed — on-chain checkpoint only, LOWER BOUND"
          }
        >
          {formatTokenAmount(position.feeOwedA, position.decimalsA)} {symbolA}
          {" + "}
          {formatTokenAmount(position.feeOwedB, position.decimalsB)} {symbolB}
        </Fact>
      </dl>

      <ViabilityRow viability={position.viability} inRange={position.inRange} />

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
