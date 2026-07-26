"use client";

/**
 * Hedge purchase flow for one eligible (SOL/USDC, in-range) position:
 *
 *   Step 1 — quote: premium / collateral / total, caps, corridor,
 *            premium breakdown, term-sheet hash, live TTL countdown;
 *   Step 2 — consent: the six Master-Terms acknowledgments (all
 *            required) + jurisdiction self-attestation;
 *   Step 3 — payment: treasury / exact amount / memo reference with
 *            copy buttons, 5s status polling until activation;
 *   then the active-certificate card (expiry countdown, caps, live
 *   estimated payoff via the corridor clamp) and the settlement view.
 *
 * All money renders with an explicit "$" and 2–6 decimals; model
 * figures carry hypothetical/no-advice captions (FR-L3).
 */

import { useCallback, useEffect, useState } from "react";
import type { CertificateRecord, QuoteRecord } from "@lh/hedge";
import type { ValueCurvePoint } from "@lh/portfolio";
import type { PortfolioPositionWire } from "@/lib/portfolio-api";
import type {
  HedgePaymentInstructions,
  HedgeQuoteResponse,
  HedgeStatusResponse,
} from "@/lib/hedge-api";
import {
  formatCountdown,
  formatUsdc,
  formatUsdcExact,
  formatUsdcSigned,
} from "@/lib/hedge-api";
import { formatNumber } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

type Phase =
  | "idle" //     panel closed, nothing loaded
  | "loading" //  quote request in flight
  | "error" //    quote request failed (message shown)
  | "quote" //    step 1
  | "consent" //  step 2
  | "payment" //  step 3 — polling for activation
  | "active" //   certificate active — polling for settlement
  | "done"; //    settled or expired

const buttonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";
const quietButtonClass =
  "rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900";

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight">{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
        {children}
      </dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
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
          // Clipboard unavailable (permissions) — value stays selectable.
        }
      }}
      className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Labelled monospace value with a copy button (payment instructions). */
function CopyField({
  label,
  display,
  copyValue,
}: {
  label: string;
  display: string;
  copyValue: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <code
          className="min-w-0 flex-1 break-all font-mono text-xs"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {display}
        </code>
        <CopyButton value={copyValue} label={label} />
      </div>
    </div>
  );
}

/** Linear interpolation of the position's V(S) curve at a given price. */
function interpolateCurve(curve: ValueCurvePoint[], price: number): number | null {
  if (curve.length === 0) return null;
  if (price <= curve[0].price) return curve[0].value;
  const last = curve[curve.length - 1];
  if (price >= last.price) return last.value;
  for (let i = 1; i < curve.length; i++) {
    if (price <= curve[i].price) {
      const a = curve[i - 1];
      const b = curve[i];
      const t = (price - a.price) / (b.price - a.price);
      return a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

/**
 * Client-side payoff estimate Π = V(S₀) − V(clamp(S, p_l, p_u)) in µUSDC,
 * from the quote's numbers + the dashboard's live price and value curve.
 * Outside the corridor the contractual caps apply exactly.
 */
function estimatePayoffUsdc(
  quote: QuoteRecord,
  curve: ValueCurvePoint[],
  priceUsd: number,
): number | null {
  if (priceUsd <= quote.priceLowerUsd) return quote.capDownUsdc;
  if (priceUsd >= quote.priceUpperUsd) return -quote.capUpUsdc;
  const value = interpolateCurve(curve, priceUsd);
  if (value === null) return null;
  const raw = Math.round(quote.entryValueUsdc - value * 1e6);
  return Math.min(Math.max(raw, -quote.capUpUsdc), quote.capDownUsdc);
}

const STEP_LABELS: Partial<Record<Phase, string>> = {
  loading: "Requesting quote…",
  error: "Quote unavailable",
  quote: "Step 1 of 3 — Quote",
  consent: "Step 2 of 3 — Acknowledgments",
  payment: "Step 3 of 3 — Payment",
  active: "Certificate active",
  done: "Certificate settled",
};

const JURISDICTION_ATTESTATION =
  "Jurisdiction self-attestation: by continuing you confirm that you are not a US person, are not located in or accessing this site from the United States, the European Union or EEA, the United Kingdom, the British Virgin Islands, or any other restricted jurisdiction, and are not using tools to disguise your location (Master Terms §3).";

export function HedgePanel({
  owner,
  position,
}: {
  owner: string;
  position: PortfolioPositionWire;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [quote, setQuote] = useState<QuoteRecord | null>(null);
  const [payment, setPayment] = useState<HedgePaymentInstructions | null>(null);
  const [certificate, setCertificate] = useState<CertificateRecord | null>(null);
  const [consentItems, setConsentItems] = useState<string[]>([]);
  const [checks, setChecks] = useState<boolean[]>([]);
  const [devMode, setDevMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devNote, setDevNote] = useState<string | null>(null);
  const [devBusy, setDevBusy] = useState(false);
  const [nowTs, setNowTs] = useState(() => Math.floor(Date.now() / 1000));

  // 1s ticker for the quote-TTL and certificate-expiry countdowns.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(
      () => setNowTs(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [open]);

  const applyStatus = useCallback((body: HedgeStatusResponse) => {
    setDevMode(body.devMode);
    if (body.consentItems.length > 0) setConsentItems(body.consentItems);
    if (body.quote) {
      setQuote(body.quote);
      setPayment({
        treasuryAddress: body.treasuryAddress,
        amountUsdc: body.quote.totalPayableUsdc,
        memoReference: body.quote.referenceKey,
        expiresAtTs: body.quote.validUntilTs,
      });
    }
    if (body.certificate) {
      setCertificate(body.certificate);
      setPhase(body.certificate.status === "active" ? "active" : "done");
    }
  }, []);

  const requestQuote = useCallback(async () => {
    setPhase("loading");
    setError(null);
    setDevNote(null);
    setCertificate(null);
    try {
      const res = await fetch("/api/hedge/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, positionMint: position.positionMint }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : `Request failed (${res.status})`,
        );
      }
      const payload = body as HedgeQuoteResponse;
      setQuote(payload.quote);
      setPayment(payload.paymentInstructions);
      setConsentItems(payload.consentItems);
      setChecks(new Array(payload.consentItems.length).fill(false));
      setPhase("quote");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request a quote.");
      setPhase("error");
    }
  }, [owner, position.positionMint]);

  /** Open the panel: resume server-side state for this position, else quote. */
  const openPanel = useCallback(async () => {
    setOpen(true);
    if (phase !== "idle" && phase !== "error") return; // keep in-flight state
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/hedge/status?positionMint=${encodeURIComponent(position.positionMint)}`,
        { cache: "no-store" },
      );
      const body = await res.json();
      if (res.ok) {
        const status = body as HedgeStatusResponse;
        if (status.certificate) {
          applyStatus(status);
          return;
        }
        if (status.quote && status.quote.status === "open") {
          applyStatus(status);
          setChecks(new Array(status.consentItems.length).fill(false));
          setPhase("quote");
          return;
        }
      } else if (res.status === 503) {
        throw new Error(
          typeof body?.error === "string" ? body.error : "Hedge service unavailable.",
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message !== "") {
        setError(err.message);
        setPhase("error");
        return;
      }
    }
    await requestQuote();
  }, [phase, position.positionMint, applyStatus, requestQuote]);

  // 5s status polling while waiting for activation / settlement.
  useEffect(() => {
    if (!open || !quote) return;
    if (phase !== "payment" && phase !== "active") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/hedge/status?quoteId=${encodeURIComponent(quote.quoteId)}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        applyStatus((await res.json()) as HedgeStatusResponse);
      } catch {
        // Transient poll failure — next tick retries.
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, phase, quote, applyStatus]);

  const simulatePayment = useCallback(async () => {
    if (!quote) return;
    setDevBusy(true);
    setDevNote(null);
    try {
      const res = await fetch("/api/hedge/dev/simulate-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : `Request failed (${res.status})`,
        );
      }
      if (body.activated) {
        setCertificate(body.activated as CertificateRecord);
        setPhase("active");
      } else {
        setDevNote("Payment recorded but no certificate activated (see server log).");
      }
    } catch (err) {
      setDevNote(err instanceof Error ? err.message : "Simulate payment failed.");
    } finally {
      setDevBusy(false);
    }
  }, [quote]);

  const settleDue = useCallback(async () => {
    setDevBusy(true);
    setDevNote(null);
    try {
      const res = await fetch("/api/hedge/dev/settle-due", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : `Request failed (${res.status})`,
        );
      }
      const settledCount = Array.isArray(body.settled) ? body.settled.length : 0;
      if (settledCount === 0) {
        setDevNote("No certificates due for settlement yet.");
      }
      // Refresh this certificate's state immediately.
      if (quote) {
        const statusRes = await fetch(
          `/api/hedge/status?quoteId=${encodeURIComponent(quote.quoteId)}`,
          { cache: "no-store" },
        );
        if (statusRes.ok) {
          applyStatus((await statusRes.json()) as HedgeStatusResponse);
        }
      }
    } catch (err) {
      setDevNote(err instanceof Error ? err.message : "Settle due failed.");
    } finally {
      setDevBusy(false);
    }
  }, [quote, applyStatus]);

  const quoteTtl = quote ? quote.validUntilTs - nowTs : 0;
  const quoteExpired =
    !!quote && !certificate && (quoteTtl <= 0 || quote.status === "lapsed");
  const allChecked =
    consentItems.length > 0 &&
    checks.length === consentItems.length &&
    checks.every(Boolean);

  const expiredNotice = (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-zinc-300 px-3 py-2 dark:border-zinc-700">
      <StatusBadge tone="warning" label="Quote expired" />
      <span className="text-sm text-zinc-600 dark:text-zinc-400">
        Quote expired — request a new one.
      </span>
      <button type="button" onClick={requestQuote} className={buttonClass}>
        Request new quote
      </button>
    </div>
  );

  const payoffEstimateUsdc =
    quote && certificate?.status === "active"
      ? estimatePayoffUsdc(quote, position.curve, position.price)
      : null;

  return (
    <div className="mt-4">
      {!open ? (
        <button type="button" onClick={openPanel} className={buttonClass}>
          Hedge this position
        </button>
      ) : (
        <section
          className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
          aria-label="Hedge purchase"
        >
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <h4 className="text-sm font-semibold tracking-tight">
                Liquidity Hedge certificate
              </h4>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {STEP_LABELS[phase] ?? ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={quietButtonClass}
            >
              Close
            </button>
          </header>

          <div className="mt-4">
            {phase === "loading" && (
              <div
                className="h-24 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
                aria-hidden="true"
              />
            )}

            {phase === "error" && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {error}
                </p>
                <div>
                  <button type="button" onClick={requestQuote} className={buttonClass}>
                    Try again
                  </button>
                </div>
              </div>
            )}

            {phase === "quote" && quote && (
              <div className="flex flex-col gap-4">
                {quoteExpired ? (
                  expiredNotice
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span>
                      Quote is an offer open for the validity period, then lapses
                      (Master Terms §4.1).
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      Valid for {formatCountdown(quoteTtl)}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <StatTile label="Premium" value={formatUsdc(quote.premiumUsdc)} />
                  <StatTile
                    label="Collateral (= Cap up)"
                    value={formatUsdc(quote.capUpUsdc)}
                  />
                  <StatTile
                    label="Total payable now"
                    value={formatUsdc(quote.totalPayableUsdc)}
                    sub="Premium + Collateral"
                  />
                </div>

                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <Fact label="Cap down (max paid to you)">
                    {formatUsdc(quote.capDownUsdc)}
                  </Fact>
                  <Fact label="Cap up (max you can owe, prefunded)">
                    {formatUsdc(quote.capUpUsdc)}
                  </Fact>
                  <Fact label="Corridor [p_l, p_u]">
                    {formatNumber(quote.priceLowerUsd)} –{" "}
                    {formatNumber(quote.priceUpperUsd)} USDC
                  </Fact>
                  <Fact label="Entry price S₀">
                    {formatNumber(quote.entryPriceUsd)} USDC
                  </Fact>
                </dl>

                <div>
                  <h5 className="text-xs text-zinc-500 dark:text-zinc-400">
                    Premium breakdown — Premium = max(P_floor, FV · m_vol − y · E[F])
                  </h5>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-t border-zinc-200 dark:border-zinc-800">
                          <td className="py-1.5 pr-4">FV — fair value (risk-neutral GBM)</td>
                          <td
                            className="py-1.5 text-right"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {formatUsdc(quote.breakdown.fairValueUsdc)}
                          </td>
                        </tr>
                        <tr className="border-t border-zinc-200 dark:border-zinc-800">
                          <td className="py-1.5 pr-4">
                            m_vol — volatility markup (max of floor, IV/RV)
                          </td>
                          <td
                            className="py-1.5 text-right"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            ×{quote.breakdown.effectiveMarkup.toFixed(4)}
                          </td>
                        </tr>
                        <tr className="border-t border-zinc-200 dark:border-zinc-800">
                          <td className="py-1.5 pr-4">
                            − y · E[F] — fee-split discount
                          </td>
                          <td
                            className="py-1.5 text-right"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            −{formatUsdc(quote.breakdown.feeDiscountUsdc)}
                          </td>
                        </tr>
                        <tr className="border-t border-zinc-200 dark:border-zinc-800">
                          <td className="py-1.5 pr-4">P_floor — minimum premium</td>
                          <td
                            className="py-1.5 text-right"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {formatUsdc(quote.breakdown.premiumFloorUsdc)}
                          </td>
                        </tr>
                        <tr className="border-y border-zinc-200 dark:border-zinc-800">
                          <td className="py-1.5 pr-4">σ — annualized realized vol</td>
                          <td
                            className="py-1.5 text-right"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {(quote.breakdown.sigmaAnnual * 100).toFixed(1)}%
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <h5 className="text-xs text-zinc-500 dark:text-zinc-400">
                    Term sheet hash (SHA-256) — shown before acceptance, anchored at
                    activation
                  </h5>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 break-all font-mono text-xs">
                      {quote.termSheetHash}
                    </code>
                    <CopyButton value={quote.termSheetHash} label="term sheet hash" />
                  </div>
                </div>

                {!quoteExpired && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setPhase("consent")}
                      className={buttonClass}
                    >
                      Continue to acknowledgments
                    </button>
                  </div>
                )}
              </div>
            )}

            {phase === "consent" && quote && (
              <div className="flex flex-col gap-4">
                {quoteExpired && expiredNotice}
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Each acknowledgment below is required and is recorded with a
                  timestamp at purchase.
                </p>
                <div className="flex flex-col gap-3">
                  {consentItems.map((text, i) => (
                    <label key={i} className="flex items-start gap-2.5 text-sm leading-5">
                      <input
                        type="checkbox"
                        checked={checks[i] ?? false}
                        onChange={(e) =>
                          setChecks((prev) => {
                            const next = [...prev];
                            next[i] = e.target.checked;
                            return next;
                          })
                        }
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--chart-series)]"
                      />
                        <span>{text}</span>
                    </label>
                  ))}
                </div>
                <p className="rounded-md border border-zinc-200 px-3 py-2 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                  {JURISDICTION_ATTESTATION}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPhase("quote")}
                    className={quietButtonClass}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!allChecked || quoteExpired}
                    onClick={() => setPhase("payment")}
                    className={buttonClass}
                  >
                    Continue to payment
                  </button>
                </div>
              </div>
            )}

            {phase === "payment" && quote && payment && (
              <div className="flex flex-col gap-4">
                {quoteExpired ? (
                  expiredNotice
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span role="status">
                      Waiting for your payment — checking every 5 seconds…
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      Quote valid for {formatCountdown(quoteTtl)}
                    </span>
                  </div>
                )}

                <div className="flex flex-col gap-3">
                  <CopyField
                    label="Treasury address (pay to)"
                    display={payment.treasuryAddress}
                    copyValue={payment.treasuryAddress}
                  />
                  <CopyField
                    label={`Amount — exactly ${formatUsdcExact(payment.amountUsdc)} in USDC`}
                    display={(payment.amountUsdc / 1e6).toFixed(6)}
                    copyValue={(payment.amountUsdc / 1e6).toFixed(6)}
                  />
                  <CopyField
                    label="Memo reference (must accompany the transfer)"
                    display={payment.memoReference}
                    copyValue={payment.memoReference}
                  />
                </div>

                <div
                  className="rounded-md border px-3 py-2"
                  style={{
                    borderColor: "var(--status-warning)",
                    backgroundColor: "rgba(250, 178, 25, 0.12)",
                  }}
                >
                  <p className="text-sm leading-5">
                    Send EXACTLY this amount in USDC with EXACTLY this memo — any
                    other transfer cannot activate the certificate and will be
                    refunded per Master Terms §4.4
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPhase("consent")}
                    className={quietButtonClass}
                  >
                    Back
                  </button>
                  {devMode && !quoteExpired && (
                    <button
                      type="button"
                      onClick={simulatePayment}
                      disabled={devBusy}
                      className={buttonClass}
                    >
                      {devBusy ? "Working…" : "Simulate payment (dev)"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {phase === "active" && quote && certificate && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge tone="good" label="Certificate active" />
                  <span
                    className="text-xs text-zinc-500 dark:text-zinc-400"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    Expires in {formatCountdown(certificate.expiryTs - nowTs)} (
                    {new Date(certificate.expiryTs * 1000).toLocaleString()})
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    label="Estimated payoff Π (now)"
                    value={
                      payoffEstimateUsdc === null
                        ? "unavailable"
                        : formatUsdcSigned(payoffEstimateUsdc)
                    }
                    sub={`at ${formatNumber(position.price)} USDC`}
                  />
                  <StatTile
                    label="Cap down (max to you)"
                    value={formatUsdc(certificate.capDownUsdc)}
                  />
                  <StatTile
                    label="Cap up (covered by collateral)"
                    value={formatUsdc(certificate.capUpUsdc)}
                  />
                  <StatTile
                    label="Premium paid"
                    value={formatUsdc(certificate.premiumUsdc)}
                  />
                </div>

                <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  Estimated from the current dashboard price via the corridor clamp
                  Π = V(S₀) − V(clamp(S, p_l, p_u)) — hypothetical, not a prediction
                  and not investment advice. Settlement uses the Master Terms §7.1
                  price policy at expiry.
                </p>

                {devMode && (
                  <div>
                    <button
                      type="button"
                      onClick={settleDue}
                      disabled={devBusy}
                      className={buttonClass}
                    >
                      {devBusy ? "Working…" : "Settle due (dev)"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {phase === "done" && certificate?.settlement && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge
                    tone="good"
                    label={
                      certificate.status === "settled" ? "Settled" : "Expired (Π = 0)"
                    }
                  />
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    settled{" "}
                    {new Date(
                      certificate.settlement.settledAtTs * 1000,
                    ).toLocaleString()}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    label="Settlement price S_T"
                    value={`${formatNumber(certificate.settlement.settlementPriceUsd)} USDC`}
                  />
                  <StatTile
                    label="Payoff Π"
                    value={formatUsdcSigned(certificate.settlement.payoffUsdc)}
                  />
                  <StatTile
                    label="Fee split"
                    value={formatUsdc(certificate.settlement.feeSplitUsdc)}
                  />
                  <StatTile
                    label="Paid to you (§7.2)"
                    value={formatUsdc(certificate.settlement.settlementAmountUsdc)}
                    sub="max(0, Π − fee split + collateral)"
                  />
                </div>

                <div>
                  <button type="button" onClick={requestQuote} className={buttonClass}>
                    Request a new quote
                  </button>
                </div>
              </div>
            )}
          </div>

          {devNote && (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400" role="status">
              {devNote}
            </p>
          )}

          <p className="mt-4 border-t border-zinc-200 pt-3 text-[11px] leading-4 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            A certificate is a bilateral contract with Blocksventures Ltd. as your
            sole counterparty — not insurance, not a deposit, not custody. Figures
            shown are model outputs — hypothetical, not a prediction and not
            investment advice.
          </p>
        </section>
      )}
    </div>
  );
}
