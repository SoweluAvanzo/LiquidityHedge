"use client";

/**
 * Copyable values — used by the hedge payment step and the data checkout,
 * so an address, an amount and a memo are presented the same way wherever
 * money is about to move.
 */

import { useState, type ReactNode } from "react";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions) — the value stays selectable.
        }
      }}
      className="lh-btn lh-btn-ghost lh-btn-xs"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Labelled monospace value with a copy button. */
export function CopyField({
  label,
  display,
  copyValue,
  help,
  children,
}: {
  label: string;
  display: string;
  copyValue: string;
  help?: ReactNode;
  /** Extra control rendered next to Copy (e.g. an "open in wallet" link). */
  children?: ReactNode;
}) {
  return (
    <div className="lh-field">
      <span className="lh-label">{label}</span>
      <div className="lh-copy">
        <code className="lh-copy-value">{display}</code>
        {children}
        <CopyButton value={copyValue} label={label} />
      </div>
      {help ? <p className="lh-help">{help}</p> : null}
    </div>
  );
}
