"use client";

/**
 * Monte-Carlo fan chart: portfolio value vs time (weeks).
 * - nested quantile bands in the single series hue: p05–p95 as a ~10% wash,
 *   p25–p75 as a stronger wash (one hue, light→dark — magnitude, not identity)
 * - p50 median as the only 2px line; selective direct labels (p95/p50/p05)
 *   at the right edge in text ink, never in the series color
 * - initial-value hairline (solid, recessive) so gain/loss reads instantly
 * - crosshair + tooltip listing every quantile at the hovered step,
 *   arrow-key navigation on focus; a <details> data table as the
 *   no-hover/WCAG twin (weekly rows)
 * Colors come from the theme-aware --chart-* tokens in globals.css.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { FanSeries } from "@lh/risk-models";
import { formatUsd } from "@/lib/format";

const W = 640;
const H = 260;
const PAD_L = 10;
const PAD_R = 34; // room for right-edge quantile labels
const PAD_T = 14;
const PAD_B = 22; // x-axis label band

interface FanChartProps {
  fan: FanSeries;
  initialValue: number;
  /**
   * What the y-axis measures (composition-dependent), e.g.
   * "portfolio value + accrued fees" or "accrued fees".
   */
  yCaption?: string;
}

const TOOLTIP_ROWS = [
  { key: "p95", label: "p95" },
  { key: "p75", label: "p75" },
  { key: "p50", label: "median" },
  { key: "p25", label: "p25" },
  { key: "p05", label: "p05" },
] as const;

export function FanChart({
  fan,
  initialValue,
  yCaption = "portfolio value",
}: FanChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const steps = fan.p50.length;
  const weeks = (steps - 1) / 7;

  const geom = useMemo(() => {
    if (steps < 2) return null;
    let vMin = initialValue;
    let vMax = initialValue;
    for (let i = 0; i < steps; i++) {
      if (fan.p05[i] < vMin) vMin = fan.p05[i];
      if (fan.p95[i] > vMax) vMax = fan.p95[i];
    }
    if (!(vMax > vMin)) {
      vMax = vMin + 1;
      vMin = vMin - 1;
    }
    const x = (i: number) => PAD_L + (i / (steps - 1)) * (W - PAD_L - PAD_R);
    const y = (v: number) =>
      H - PAD_B - ((v - vMin) / (vMax - vMin)) * (H - PAD_T - PAD_B);

    const line = (series: number[]) =>
      series
        .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`)
        .join("");
    // Band polygon: upper series forward, lower series backward.
    const band = (upper: number[], lower: number[]) =>
      upper
        .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`)
        .join("") +
      [...lower]
        .reverse()
        .map((v, i) => `L${x(steps - 1 - i).toFixed(2)},${y(v).toFixed(2)}`)
        .join("") +
      "Z";

    return {
      vMin,
      vMax,
      x,
      y,
      outerBand: band(fan.p95, fan.p05),
      innerBand: band(fan.p75, fan.p25),
      medianPath: line(fan.p50),
    };
  }, [fan, initialValue, steps]);

  const pointerToIdx = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const vx = ((clientX - rect.left) / rect.width) * W;
      const i = Math.round(((vx - PAD_L) / (W - PAD_L - PAD_R)) * (steps - 1));
      return Math.max(0, Math.min(steps - 1, i));
    },
    [steps],
  );

  if (!geom) return null;
  const { x, y, vMin, vMax, outerBand, innerBand, medianPath } = geom;

  const baselineY = H - PAD_B;
  const startY = y(initialValue);
  const hover = hoverIdx !== null ? hoverIdx : null;
  const hoverX = hover !== null ? x(hover) : 0;

  const weekLabel = (i: number) => {
    const w = i / 7;
    return Number.isInteger(w) ? `${w}w` : `${w.toFixed(1)}w`;
  };

  // Right-edge direct labels: nudge apart only if the fan is very tight.
  const endLabels = [
    { text: "p95", yPos: y(fan.p95[steps - 1]) },
    { text: "p50", yPos: y(fan.p50[steps - 1]) },
    { text: "p05", yPos: y(fan.p05[steps - 1]) },
  ];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--chart-series)]"
        role="img"
        aria-label={`Simulated ${yCaption} fan over ${weeks} weeks. Median ends at ${formatUsd(fan.p50[steps - 1])}; 90 percent of paths end between ${formatUsd(fan.p05[steps - 1])} and ${formatUsd(fan.p95[steps - 1])}. Initial value ${formatUsd(initialValue)}. Use arrow keys to inspect steps; full values in the data table below.`}
        tabIndex={0}
        onPointerMove={(e) => setHoverIdx(pointerToIdx(e.clientX))}
        onPointerLeave={() => setHoverIdx(null)}
        onFocus={() => setHoverIdx(steps - 1)}
        onBlur={() => setHoverIdx(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const delta = e.key === "ArrowLeft" ? -1 : 1;
            setHoverIdx((prev) =>
              Math.max(0, Math.min(steps - 1, (prev ?? steps - 1) + delta)),
            );
          }
        }}
      >
        {/* Quantile bands: one hue, nested washes (p05–p95, then p25–p75) */}
        <path d={outerBand} fill="var(--chart-band)" />
        <path d={innerBand} fill="var(--chart-band-strong)" />

        {/* Baseline: solid hairline, recessive */}
        <line
          x1={PAD_L}
          y1={baselineY}
          x2={W - PAD_R}
          y2={baselineY}
          stroke="var(--chart-axis)"
          strokeWidth={1}
        />

        {/* Initial-value hairline (solid — a reference, not a grid) */}
        <line
          x1={PAD_L}
          y1={startY}
          x2={W - PAD_R}
          y2={startY}
          stroke="var(--chart-ink-muted)"
          strokeWidth={1}
        />
        <text
          x={PAD_L + 2}
          y={startY - 4}
          fontSize={10}
          fill="var(--chart-ink-muted)"
          stroke="var(--chart-surface)"
          strokeWidth={3}
          paintOrder="stroke"
        >
          start {formatUsd(initialValue)}
        </text>

        {/* Median: the single 2px series line */}
        <path
          d={medianPath}
          fill="none"
          stroke="var(--chart-series)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Right-edge quantile labels — text ink, never the series color */}
        {endLabels.map(({ text, yPos }) => (
          <text
            key={text}
            x={W - PAD_R + 4}
            y={yPos + 3}
            fontSize={10}
            fill="var(--chart-ink-muted)"
            stroke="var(--chart-surface)"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {text}
          </text>
        ))}

        {/* Crosshair (hover/focus) */}
        {hover !== null && (
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
              cy={y(fan.p50[hover])}
              r={4.5}
              fill="var(--chart-series)"
              stroke="var(--chart-surface)"
              strokeWidth={2}
            />
          </g>
        )}

        {/* Axis min/max labels only */}
        <text x={PAD_L} y={H - 6} fontSize={11} fill="var(--chart-ink-muted)">
          0w
        </text>
        <text
          x={W - PAD_R}
          y={H - 6}
          textAnchor="end"
          fontSize={11}
          fill="var(--chart-ink-muted)"
        >
          {weekLabel(steps - 1)}
        </text>
        <text
          x={PAD_L + 2}
          y={PAD_T + 10}
          fontSize={11}
          fill="var(--chart-ink-muted)"
          stroke="var(--chart-surface)"
          strokeWidth={3}
          paintOrder="stroke"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatUsd(vMax)}
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
          {formatUsd(vMin)}
        </text>
      </svg>

      {/* Axis caption — states what the y-axis measures (composition-aware) */}
      <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        y-axis: {yCaption}, USD · x-axis: weeks
      </div>

      {/* Tooltip: values lead (strong), quantile labels follow (secondary) */}
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          style={
            hoverX < W / 2
              ? { left: `${((hoverX + 10) / W) * 100}%` }
              : { right: `${((W - hoverX + 10) / W) * 100}%` }
          }
        >
          <div className="mb-0.5 text-zinc-500 dark:text-zinc-400">
            {weekLabel(hover)} (day {hover})
          </div>
          {TOOLTIP_ROWS.map(({ key, label }) => (
            <div key={key} className="flex items-baseline justify-between gap-3">
              <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
              <span
                className={key === "p50" ? "font-semibold" : ""}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatUsd(fan[key][hover])}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Table twin: every value reachable without hover (weekly rows) */}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300">
          Data table (weekly quantiles)
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr className="text-left text-zinc-500 dark:text-zinc-400">
                <th className="py-1 pr-3 font-medium">Week</th>
                <th className="py-1 pr-3 font-medium">p05</th>
                <th className="py-1 pr-3 font-medium">p25</th>
                <th className="py-1 pr-3 font-medium">Median</th>
                <th className="py-1 pr-3 font-medium">p75</th>
                <th className="py-1 pr-3 font-medium">p95</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.floor((steps - 1) / 7) + 1 }, (_, w) => {
                const i = Math.min(w * 7, steps - 1);
                return (
                  <tr key={w} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-3">{w}</td>
                    <td className="py-1 pr-3">{formatUsd(fan.p05[i])}</td>
                    <td className="py-1 pr-3">{formatUsd(fan.p25[i])}</td>
                    <td className="py-1 pr-3 font-medium">{formatUsd(fan.p50[i])}</td>
                    <td className="py-1 pr-3">{formatUsd(fan.p75[i])}</td>
                    <td className="py-1 pr-3">{formatUsd(fan.p95[i])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
