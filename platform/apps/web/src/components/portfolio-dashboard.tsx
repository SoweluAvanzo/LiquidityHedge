"use client";

/**
 * Live portfolio dashboard (FR-M2/M4/M5/M7, FR-W3).
 *
 * Data source is the connected wallet's pubkey OR a pasted "watch address"
 * (read-only watch mode). All chain access goes through /api/portfolio so
 * the server-side RPC endpoint never reaches the browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { PortfolioResponse } from "@/lib/portfolio-api";
import { apiFetch, errorMessage, retryAtFrom } from "@/lib/api-client";
import { formatUsd } from "@/lib/format";
import { RateLimitNotice } from "@/components/ui/rate-limit-notice";
import { PositionCard } from "@/components/position-card";
import { SimulateSection } from "@/components/simulate-section";
import { HedgeTransparencyFooter } from "@/components/hedge-footer";

/**
 * A real portfolio anyone can open without a wallet — the fastest way to
 * see what the dashboard actually does. Public address, read-only.
 */
const EXAMPLE_OWNER = "6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj";

function validatePubkey(input: string): string | null {
  try {
    return new PublicKey(input.trim()).toBase58();
  } catch {
    return null;
  }
}

function Fact({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="lh-fact">
      <span className="lh-fact-label">{label}</span>
      <p className="lh-fact-value lh-fact-value-lg">{value}</p>
      {sub && <p className="lh-fact-sub">{sub}</p>}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="lh-facts lh-facts-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="lh-fact" style={{ height: "4.6rem" }}>
          <div className="lh-skeleton" style={{ height: "100%" }} />
        </div>
      ))}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="lh-skeleton" style={{ height: "18rem" }} aria-hidden="true" />
  );
}

export function PortfolioDashboard({
  walletAddress,
}: {
  walletAddress: string | null;
}) {
  const [watchInput, setWatchInput] = useState("");
  const [watchAddress, setWatchAddress] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the API answered 429; until it passes, asking again is futile.
  const [retryAtTs, setRetryAtTs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Watch address (explicit) wins over the connected wallet.
  const owner = watchAddress ?? walletAddress;

  const load = useCallback(async (ownerKey: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // Yield a microtask so state updates happen asynchronously — no
    // synchronous setState cascade when invoked from the mount effect.
    await Promise.resolve();
    if (controller.signal.aborted) return;
    setLoading(true);
    setError(null);
    setRetryAtTs(null);
    try {
      const body = await apiFetch<PortfolioResponse>(
        `/api/portfolio?owner=${encodeURIComponent(ownerKey)}`,
        { signal: controller.signal },
      );
      setData(body);
    } catch (err) {
      if (controller.signal.aborted) return;
      setRetryAtTs(retryAtFrom(err));
      setError(errorMessage(err, "Failed to load portfolio."));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  // Reset-on-owner-change happens during render (React's "adjusting state
  // when a prop changes" pattern) — the effect only talks to the network.
  const [prevOwner, setPrevOwner] = useState(owner);
  if (owner !== prevOwner) {
    setPrevOwner(owner);
    setData(null);
    setError(null);
    setRetryAtTs(null);
  }

  useEffect(() => {
    // Canonical fetch-on-mount: `load` performs no synchronous setState —
    // every state update sits behind an initial awaited microtask (see
    // load()), so no render cascade is possible. The rule's static
    // analysis cannot see through the await; suppressed deliberately.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (owner) void load(owner);
    return () => abortRef.current?.abort();
  }, [owner, load]);

  const applyWatch = (raw?: string) => {
    const value = raw ?? watchInput;
    if (value.trim() === "") {
      setWatchAddress(null);
      setWatchError(null);
      return;
    }
    const key = validatePubkey(value);
    if (!key) {
      setWatchError("Not a valid base58 Solana public key.");
      return;
    }
    setWatchError(null);
    setWatchInput(key);
    setWatchAddress(key);
  };

  const asOfLabel = data
    ? new Date(data.asOf).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;
  const initialLoading = loading && !data;
  const refreshing = loading && !!data;

  return (
    <div className="lh-stack">
      <div className="lh-page-head" style={{ marginBottom: 0 }}>
        <div>
          <p className="lh-eyebrow">Liquidity Studio · concentrated liquidity</p>
          <h1 className="lh-h1">Concentrated-liquidity positions.</h1>
        </div>
        <p className="lh-note" style={{ maxWidth: "34ch" }}>
          Read-only. No signature is ever requested and no key or seed phrase
          is ever asked for.
        </p>
      </div>

      {/* Watch-address input — read-only watch mode (FR-W3) */}
      <section className="lh-card lh-card-tight" aria-labelledby="watch-label">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            gap: "0.6rem",
          }}
        >
          <div className="lh-field" style={{ flex: "1 1 22rem" }}>
            <label className="lh-label" htmlFor="watch-address" id="watch-label">
              Watch address{" "}
              <span className="lh-label-optional">(read-only watch mode)</span>
            </label>
            <input
              id="watch-address"
              className="lh-input lh-input-mono"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste any Solana public address to watch it"
              value={watchInput}
              aria-invalid={!!watchError}
              aria-describedby="watch-help"
              onChange={(e) => setWatchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyWatch();
              }}
            />
          </div>
          <button
            type="button"
            className="lh-btn lh-btn-ghost"
            onClick={() => applyWatch()}
          >
            Watch
          </button>
          {watchAddress && (
            <button
              type="button"
              className="lh-btn lh-btn-quiet"
              onClick={() => {
                setWatchAddress(null);
                setWatchInput("");
                setWatchError(null);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {watchError && (
          <p className="lh-error-text" role="alert" style={{ marginTop: "0.5rem" }}>
            {watchError}
          </p>
        )}
        <p className="lh-help" id="watch-help" style={{ marginTop: "0.5rem" }}>
          Watching only reads public on-chain data — no signature is ever
          requested. Enter a public address only; never enter a seed phrase or
          private key.
        </p>
      </section>

      {!owner ? (
        <section className="lh-card" aria-labelledby="empty-h">
          <p className="lh-eyebrow">Nothing loaded yet</p>
          <h2 className="lh-h2" id="empty-h" style={{ marginTop: "0.35rem" }}>
            Read any concentrated-liquidity position, straight from the chain.
          </h2>
          <p className="lh-lead">
            Paste a public Solana address above, or connect a wallet, and this
            page reads every concentrated-liquidity position that address owns: its
            value and token split, its range and whether the price is inside it
            right now, uncollected fees, the V(S) payoff curve, and a viability
            index that sets measured fee yield against the breakeven the range
            needs. It is read-only by construction — it never requests a
            transaction signature and will never ask for a seed phrase.
          </p>

          <div className="lh-btn-row" style={{ marginTop: "1.5rem" }}>
            <button
              type="button"
              className="lh-btn"
              onClick={() => applyWatch(EXAMPLE_OWNER)}
            >
              View an example portfolio
            </button>
            <span className="lh-help">
              Loads the public address{" "}
              <span className="lh-num">{EXAMPLE_OWNER}</span> in watch mode. No
              wallet, no account.
            </span>
          </div>

          <ul className="lh-list" style={{ marginTop: "1.75rem" }}>
            <li>
              <b>Three independent simulators.</b> Geometric Brownian motion, an
              empirical bootstrap of historical returns, and historical replay
              of the path the market actually took.
            </li>
            <li>
              <b>Every model number is labelled.</b> Which estimator produced
              it, over which window, with which uncertainty band.
            </li>
            <li>
              <b>Server-side RPC.</b>{" "}
              Chain access runs through this app&rsquo;s own API, so no provider
              key or endpoint reaches your browser.
            </li>
          </ul>
        </section>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem 1rem",
            }}
          >
            <p className="lh-prov">
              <span className="lh-prov-key">
                {watchAddress ? "watching" : "connected"}
              </span>
              <span style={{ wordBreak: "break-all" }}>{owner}</span>
            </p>
            <div className="lh-btn-row">
              {asOfLabel && (
                <span className="lh-card-meta">as of {asOfLabel}</span>
              )}
              <button
                type="button"
                className="lh-btn lh-btn-ghost"
                onClick={() => owner && load(owner)}
                disabled={loading}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {retryAtTs !== null ? (
            <RateLimitNotice
              retryAtTs={retryAtTs}
              what="Portfolio reads"
              onRetry={() => owner && load(owner)}
            />
          ) : error ? (
            <section className="lh-callout" data-tone="alert">
              <p className="lh-callout-h">Could not load this portfolio</p>
              <p>{error}</p>
              <div className="lh-btn-row" style={{ marginTop: "0.85rem" }}>
                <button
                  type="button"
                  className="lh-btn lh-btn-ghost"
                  onClick={() => owner && load(owner)}
                >
                  Try again
                </button>
              </div>
            </section>
          ) : initialLoading ? (
            <div className="lh-stack">
              <SummarySkeleton />
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : data ? (
            // On refetch, hold the previous render at reduced opacity —
            // no skeleton flash, no layout jump.
            <div
              className={`lh-stack${refreshing ? " lh-dim" : ""}`}
              aria-busy={refreshing}
            >
              <dl className="lh-facts lh-facts-4">
                <Fact
                  label="Total value"
                  value={formatUsd(data.summary.totalValueUsd)}
                  sub="USDC-quoted positions only"
                />
                <Fact
                  label="Positions"
                  value={String(data.summary.positionsCount)}
                />
                <Fact
                  label="In range"
                  value={`${data.summary.inRangeCount} of ${data.summary.positionsCount}`}
                  sub="price inside [p_l, p_u] right now"
                />
                <Fact
                  label="Unpriced"
                  value={String(data.summary.unpricedCount)}
                  sub="non-USDC quote — value not converted"
                />
              </dl>

              {data.positions.length === 0 ? (
                <section className="lh-card lh-card-dashed">
                  <h2 className="lh-h2">No positions found here</h2>
                  <p className="lh-p">
                    This address owns no concentrated-liquidity position NFTs on a
                    covered venue. Check the
                    address, or load the example portfolio to see the dashboard
                    with data in it.
                  </p>
                  <div className="lh-btn-row" style={{ marginTop: "1rem" }}>
                    <button
                      type="button"
                      className="lh-btn lh-btn-ghost"
                      onClick={() => applyWatch(EXAMPLE_OWNER)}
                    >
                      View an example portfolio
                    </button>
                  </div>
                </section>
              ) : (
                <div className="lh-stack">
                  {data.positions.map((position) => (
                    <PositionCard
                      key={position.positionAddress}
                      position={position}
                      owner={owner}
                    />
                  ))}
                </div>
              )}

              {data.positions.length > 0 && <SimulateSection owner={owner} />}

              <HedgeTransparencyFooter />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
