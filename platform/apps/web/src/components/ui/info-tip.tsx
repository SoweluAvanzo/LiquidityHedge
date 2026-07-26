"use client";

/**
 * Small hover/focus info tip — keyboard reachable, title-based.
 *
 * It carries provenance text VERBATIM (which estimator, which basis, which
 * assumption). Tidiness never removes a disclosure; it only makes it
 * quieter than the number it qualifies.
 */

export function InfoTip({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      className="lh-tip"
      title={text}
      aria-label={text}
      role="note"
    >
      i
    </span>
  );
}
