"use client";

/**
 * Hedge transparency footer (Master Terms §9.1: reserve and exposure
 * figures are published on the Site). Renders only when the ledger has
 * any activity; shows the treasury address, net reserves, active
 * exposure, the runtime invariant status and the paused flag from the
 * ledger's FR-A5 monitor hook. Refreshes every 30 seconds.
 */

import { useEffect, useState } from "react";
import type { HedgeStatusResponse } from "@/lib/hedge-api";
import { formatUsdc } from "@/lib/hedge-api";
import { shortenAddress } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

function FooterStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs text-zinc-600 dark:text-zinc-400">
      {label}:{" "}
      <span
        className="font-medium text-zinc-900 dark:text-zinc-100"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
    </span>
  );
}

export function HedgeTransparencyFooter() {
  const [status, setStatus] = useState<HedgeStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/hedge/status", { cache: "no-store" });
        if (!res.ok) return; // unconfigured (503) or transient — stay hidden
        const body = (await res.json()) as HedgeStatusResponse;
        if (!cancelled) setStatus(body);
      } catch {
        // Transient network failure — keep the last known state.
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status || !status.hasActivity) return null;

  return (
    <footer className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Hedge transparency
        </span>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          Treasury:{" "}
          <span className="font-mono" title={status.treasuryAddress}>
            {shortenAddress(status.treasuryAddress)}
          </span>
        </span>
        <FooterStat
          label="Net reserves"
          value={formatUsdc(status.monitor.netReservesUsdc)}
        />
        <FooterStat
          label="Active exposure"
          value={formatUsdc(status.monitor.activeExposureUsdc)}
        />
        <StatusBadge
          tone={status.monitor.invariants.ok ? "good" : "critical"}
          label={
            status.monitor.invariants.ok ? "Invariants ok" : "Invariant violation"
          }
        />
        <StatusBadge
          tone={status.monitor.paused ? "warning" : "good"}
          label={status.monitor.paused ? "Quoting paused" : "Quoting live"}
        />
      </div>
      <p className="mt-1.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
        Figures reported by the ledger&rsquo;s runtime invariant monitor; treasury
        balances are verifiable on-chain. Informational only — not investment
        advice.
      </p>
    </footer>
  );
}
