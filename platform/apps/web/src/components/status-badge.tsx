"use client";

/**
 * Status badge: dot (reserved status colour) + text label — never colour
 * alone, and the same four tones everywhere in the product.
 *
 * The status palette is fixed in `tokens.css` and is never reused for a
 * data series: teal = healthy / inside the range, amber = attention,
 * brick = failure or money owed back, grey = neutral fact.
 */

export type StatusTone = "good" | "warning" | "critical" | "neutral";

export function StatusBadge({
  tone,
  label,
  title,
}: {
  tone: StatusTone;
  label: string;
  title?: string;
}) {
  return (
    <span className="lh-badge" data-tone={tone} title={title}>
      <span className="lh-badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
