"use client";

/**
 * Status badge: dot (reserved status color) + text label — never color
 * alone. Same visual contract as the dashboard's in-range/viability
 * badges; the fixed status palette comes from globals.css and is never
 * reused for data series.
 */

const TONES = {
  good: { color: "var(--status-good)", wash: "rgba(12, 163, 12, 0.10)" },
  warning: { color: "var(--status-warning)", wash: "rgba(250, 178, 25, 0.12)" },
  critical: { color: "var(--status-critical)", wash: "rgba(208, 59, 59, 0.10)" },
} as const;

export type StatusTone = keyof typeof TONES;

export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  const { color, wash } = TONES[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium dark:border-zinc-700"
      style={{ backgroundColor: wash }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
