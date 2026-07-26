"use client";

/**
 * Minimal hand-rolled SVG chart: position value V(S) vs price S.
 * - single series (slot-1 blue), 2px round line
 * - active range [priceLower, priceUpper] as a ~10% series-hue wash
 * - vertical marker + surface-ringed dot at the current price
 * - axis min/max labels only; solid hairline baseline
 * - crosshair + tooltip on hover, arrow-key navigation on focus
 * Colors come from the theme-aware --chart-* tokens in globals.css.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ValueCurvePoint } from "@lh/portfolio";
import { formatNumber, formatUsd } from "@/lib/format";

const W = 640;
const H = 220;
const PAD_L = 10;
const PAD_R = 10;
const PAD_T = 26; // room for the current-price label
const PAD_B = 22; // x-axis label band (inside the container — never clipped)

interface ValueCurveChartProps {
  curve: ValueCurvePoint[];
  price: number;
  priceLower: number;
  priceUpper: number;
  isUsdcQuoted: boolean;
  quoteSymbol: string;
  pair: string;
}

export function ValueCurveChart({
  curve,
  price,
  priceLower,
  priceUpper,
  isUsdcQuoted,
  quoteSymbol,
  pair,
}: ValueCurveChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const formatValue = useCallback(
    (v: number) =>
      isUsdcQuoted ? formatUsd(v) : `${formatNumber(v)} ${quoteSymbol}`,
    [isUsdcQuoted, quoteSymbol],
  );

  const geom = useMemo(() => {
    if (curve.length < 2) return null;
    const pMin = curve[0].price;
    const pMax = curve[curve.length - 1].price;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const pt of curve) {
      if (pt.value < vMin) vMin = pt.value;
      if (pt.value > vMax) vMax = pt.value;
    }
    if (!(vMax > vMin)) {
      vMax = vMin + 1;
      vMin = vMin - 1;
    }
    const x = (p: number) =>
      PAD_L + ((p - pMin) / (pMax - pMin)) * (W - PAD_L - PAD_R);
    const y = (v: number) =>
      H - PAD_B - ((v - vMin) / (vMax - vMin)) * (H - PAD_T - PAD_B);
    const path = curve
      .map(
        (pt, i) => `${i === 0 ? "M" : "L"}${x(pt.price).toFixed(2)},${y(pt.value).toFixed(2)}`,
      )
      .join("");
    // Uniform grid → nearest index is arithmetic, no scan needed.
    const idxAt = (p: number) =>
      Math.max(
        0,
        Math.min(
          curve.length - 1,
          Math.round(((p - pMin) / (pMax - pMin)) * (curve.length - 1)),
        ),
      );
    return { pMin, pMax, vMin, vMax, x, y, path, idxAt };
  }, [curve]);

  const pointerToIdx = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg || !geom) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const vx = ((clientX - rect.left) / rect.width) * W;
      const p =
        geom.pMin +
        ((vx - PAD_L) / (W - PAD_L - PAD_R)) * (geom.pMax - geom.pMin);
      return geom.idxAt(p);
    },
    [geom],
  );

  if (!geom) return null;

  const { x, y, path, pMin, pMax, vMin, vMax, idxAt } = geom;

  const baselineY = H - PAD_B;
  const bandX1 = x(Math.max(priceLower, pMin));
  const bandX2 = x(Math.min(priceUpper, pMax));
  const clampedPrice = Math.min(Math.max(price, pMin), pMax);
  const markerX = x(clampedPrice);
  const markerIdx = idxAt(clampedPrice);
  const markerY = y(curve[markerIdx].value);
  // Anchor the current-price label away from the edges so it never clips.
  const markerAnchor =
    markerX < W * 0.15 ? "start" : markerX > W * 0.85 ? "end" : "middle";

  const hover = hoverIdx !== null ? curve[hoverIdx] : null;
  const hoverX = hover ? x(hover.price) : 0;
  const hoverY = hover ? y(hover.value) : 0;

  return (
    <div className="lh-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="lh-chart-svg"
        role="img"
        aria-label={`${pair} position value versus price. Value ranges from ${formatValue(vMin)} to ${formatValue(vMax)} as price moves from ${formatNumber(pMin)} to ${formatNumber(pMax)}. Current price ${formatNumber(price)}. Use arrow keys to inspect points.`}
        tabIndex={0}
        onPointerMove={(e) => setHoverIdx(pointerToIdx(e.clientX))}
        onPointerLeave={() => setHoverIdx(null)}
        onFocus={() => setHoverIdx(markerIdx)}
        onBlur={() => setHoverIdx(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const delta = e.key === "ArrowLeft" ? -1 : 1;
            setHoverIdx((prev) =>
              Math.max(
                0,
                Math.min(curve.length - 1, (prev ?? markerIdx) + delta),
              ),
            );
          }
        }}
      >
        {/* Active range [p_l, p_u]: the range teal, the same colour the
            landing figure draws the range band in */}
        {bandX2 > bandX1 && (
          <rect
            x={bandX1}
            y={PAD_T}
            width={bandX2 - bandX1}
            height={baselineY - PAD_T}
            fill="var(--chart-range-wash)"
          />
        )}
        {bandX2 > bandX1 && (
          <g aria-hidden="true">
            <line
              x1={bandX1}
              y1={PAD_T}
              x2={bandX1}
              y2={baselineY}
              stroke="var(--chart-range)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <line
              x1={bandX2}
              y1={PAD_T}
              x2={bandX2}
              y2={baselineY}
              stroke="var(--chart-range)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          </g>
        )}

        {/* Baseline: solid hairline, recessive */}
        <line
          x1={PAD_L}
          y1={baselineY}
          x2={W - PAD_R}
          y2={baselineY}
          stroke="var(--chart-axis)"
          strokeWidth={1}
        />

        {/* V(S) curve */}
        <path
          d={path}
          fill="none"
          stroke="var(--chart-series)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Crosshair (hover/focus) */}
        {hover && (
          <g aria-hidden="true">
            <line
              x1={hoverX}
              y1={PAD_T}
              x2={hoverX}
              y2={baselineY}
              stroke="var(--chart-ink-muted)"
              strokeWidth={1}
            />
            <circle
              cx={hoverX}
              cy={hoverY}
              r={4.5}
              fill="var(--chart-series)"
              stroke="var(--chart-surface)"
              strokeWidth={2}
            />
          </g>
        )}

        {/* Current price marker: hairline + surface-ringed dot + label */}
        <line
          x1={markerX}
          y1={PAD_T - 4}
          x2={markerX}
          y2={baselineY}
          stroke="var(--chart-ink-secondary)"
          strokeWidth={1}
        />
        <circle
          cx={markerX}
          cy={markerY}
          r={4.5}
          fill="var(--chart-series)"
          stroke="var(--chart-surface)"
          strokeWidth={2}
        />
        <text
          x={markerX + (markerAnchor === "start" ? 4 : markerAnchor === "end" ? -4 : 0)}
          y={PAD_T - 9}
          textAnchor={markerAnchor}
          fontSize={11}
          fill="var(--chart-ink-secondary)"
        >
          {`now ${formatNumber(price)}`}
        </text>

        {/* Axis min/max labels only */}
        <text
          x={PAD_L}
          y={H - 6}
          fontSize={11}
          fill="var(--chart-ink-muted)"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatNumber(pMin)}
        </text>
        <text
          x={W - PAD_R}
          y={H - 6}
          textAnchor="end"
          fontSize={11}
          fill="var(--chart-ink-muted)"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatNumber(pMax)}
        </text>
        {/* Value min/max: surface-stroked (paint-order) so they stay
            legible where the curve passes underneath. */}
        <text
          x={PAD_L + 2}
          y={PAD_T + 12}
          fontSize={11}
          fill="var(--chart-ink-muted)"
          stroke="var(--chart-surface)"
          strokeWidth={3}
          paintOrder="stroke"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatValue(vMax)}
        </text>
        <text
          x={PAD_L + 2}
          y={baselineY - 6}
          fontSize={11}
          fill="var(--chart-ink-muted)"
          stroke="var(--chart-surface)"
          strokeWidth={3}
          paintOrder="stroke"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatValue(vMin)}
        </text>
      </svg>

      {/* Tooltip: value leads (strong), price follows (secondary) */}
      {hover && (
        <div
          className="lh-chart-tip"
          style={
            hoverX < W / 2
              ? { left: `${((hoverX + 10) / W) * 100}%` }
              : { right: `${((W - hoverX + 10) / W) * 100}%` }
          }
        >
          <span
            className="mr-1.5 inline-block h-0.5 w-3 align-middle"
            style={{ background: "var(--chart-series)" }}
            aria-hidden="true"
          />
          <span className="lh-num" style={{ fontWeight: 600 }}>
            {formatValue(hover.value)}
          </span>
          <span className="lh-chart-tip-key" style={{ marginLeft: "0.4rem" }}>
            at {formatNumber(hover.price)}
          </span>
        </div>
      )}
    </div>
  );
}
