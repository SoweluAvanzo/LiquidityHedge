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
import { formatUsd } from "@/lib/format";
import { PositionCard } from "@/components/position-card";
import { SimulateSection } from "@/components/simulate-section";
import { HedgeTransparencyFooter } from "@/components/hedge-footer";

function validatePubkey(input: string): string | null {
  try {
    return new PublicKey(input.trim()).toBase58();
  } catch {
    return null;
  }
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-[74px] animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
        />
      ))}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div
      className="h-72 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
      aria-hidden="true"
    />
  );
}

export function PortfolioDashboard({ walletAddress }: { walletAddress: string | null }) {
  const [watchInput, setWatchInput] = useState("");
  const [watchAddress, setWatchAddress] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Watch address (explicit) wins over the connected wallet.
  const owner = watchAddress ?? walletAddress;

  const load = useCallback(async (ownerKey: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portfolio?owner=${encodeURIComponent(ownerKey)}`,
        { signal: controller.signal, cache: "no-store" },
      );
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : `Request failed (${res.status})`,
        );
      }
      setData(body as PortfolioResponse);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load portfolio.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    if (owner) void load(owner);
    return () => abortRef.current?.abort();
  }, [owner, load]);

  const applyWatch = () => {
    if (watchInput.trim() === "") {
      setWatchAddress(null);
      setWatchError(null);
      return;
    }
    const key = validatePubkey(watchInput);
    if (!key) {
      setWatchError("Not a valid base58 Solana public key.");
      return;
    }
    setWatchError(null);
    setWatchAddress(key);
  };

  const asOfLabel = data ? new Date(data.asOf).toLocaleTimeString() : null;
  const initialLoading = loading && !data;
  const refreshing = loading && !!data;

  return (
    <div className="flex flex-col gap-6">
      {/* Watch-address input — read-only watch mode (FR-W3) */}
      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <label
          htmlFor="watch-address"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Watch address <span className="font-normal text-zinc-500 dark:text-zinc-400">(read-only watch mode)</span>
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="watch-address"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste any Solana public address to watch it"
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyWatch();
            }}
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm placeholder:font-sans focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:focus:border-zinc-400"
          />
          <button
            type="button"
            onClick={applyWatch}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Watch
          </button>
          {watchAddress && (
            <button
              type="button"
              onClick={() => {
                setWatchAddress(null);
                setWatchInput("");
                setWatchError(null);
              }}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              Clear
            </button>
          )}
        </div>
        {watchError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
            {watchError}
          </p>
        )}
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Watching only reads public on-chain data — no signatures are requested.
          Enter a public address only; never enter a seed phrase or private key.
        </p>
      </section>

      {!owner ? (
        <section className="mx-auto mt-10 max-w-md text-center">
          <h1 className="text-lg font-semibold tracking-tight">
            Connect a wallet or watch an address to view positions
          </h1>
          <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            This app is read-only: it only reads public on-chain data for the
            wallet you connect or the address you watch. It never requests
            transaction signatures and will never ask for your seed phrase or
            private keys.
          </p>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              {watchAddress ? "Watching" : "Connected"}:{" "}
              <span className="break-all font-mono text-xs">{owner}</span>
            </div>
            <div className="flex items-center gap-3">
              {asOfLabel && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  As of {asOfLabel}
                </span>
              )}
              <button
                type="button"
                onClick={() => owner && load(owner)}
                disabled={loading}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {error ? (
            <section className="rounded-lg border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950/40">
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              <button
                type="button"
                onClick={() => owner && load(owner)}
                className="mt-3 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
              >
                Retry
              </button>
            </section>
          ) : initialLoading ? (
            <div className="flex flex-col gap-6">
              <SummarySkeleton />
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : data ? (
            // On refetch, hold the previous render at reduced opacity —
            // no skeleton flash, no layout jump.
            <div
              className={`flex flex-col gap-6 transition-opacity ${refreshing ? "opacity-60" : ""}`}
              aria-busy={refreshing}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label="Total value (USDC-quoted)"
                  value={formatUsd(data.summary.totalValueUsd)}
                />
                <StatTile
                  label="Positions"
                  value={String(data.summary.positionsCount)}
                />
                <StatTile
                  label="In range"
                  value={`${data.summary.inRangeCount} of ${data.summary.positionsCount}`}
                />
                <StatTile
                  label="Unpriced (non-USDC)"
                  value={String(data.summary.unpricedCount)}
                />
              </div>

              {data.positions.length === 0 ? (
                <section className="rounded-lg border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    No Orca Whirlpool positions found for this address.
                  </p>
                </section>
              ) : (
                <div className="flex flex-col gap-4">
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
