"use client";

/**
 * Hedge transparency panel (Master Terms §9.1: reserve and exposure
 * figures are published on the Site). Renders only when the ledger has
 * any activity; shows the treasury address, net reserves, active
 * exposure, the runtime invariant status and the paused flag from the
 * ledger's FR-A5 monitor hook. Refreshes every 30 seconds.
 */

import { useEffect, useState } from "react";
import type { HedgeStatusResponse } from "@/lib/hedge-api";
import { formatUsdc, shortenAddress } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

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
    <section className="lh-card lh-card-tight" aria-labelledby="hedge-transparency-h">
      <p className="lh-label-block" id="hedge-transparency-h">
        Hedge transparency
      </p>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem 1.25rem",
          marginTop: "0.6rem",
        }}
      >
        <span className="lh-prov">
          <span className="lh-prov-item">
            <span className="lh-prov-key">treasury</span>
            <span title={status.treasuryAddress}>
              {shortenAddress(status.treasuryAddress)}
            </span>
          </span>
          <span className="lh-prov-item">
            <span className="lh-prov-key">net reserves</span>
            {formatUsdc(status.monitor.netReservesUsdc)}
          </span>
          <span className="lh-prov-item">
            <span className="lh-prov-key">active exposure</span>
            {formatUsdc(status.monitor.activeExposureUsdc)}
          </span>
        </span>
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
      <p className="lh-help" style={{ marginTop: "0.6rem" }}>
        Figures reported by the ledger&rsquo;s runtime invariant monitor;
        treasury balances are verifiable on-chain. Informational only — not
        investment advice.
      </p>
    </section>
  );
}
