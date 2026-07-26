"use client";

/**
 * Hedge purchase flow for one eligible (SOL/USDC, in-range) position:
 *
 *   Step 1 — quote: premium / collateral / total, caps, range,
 *            premium breakdown, term-sheet hash, live TTL countdown;
 *   Step 2 — consent: the six Master-Terms acknowledgments (all
 *            required) + jurisdiction self-attestation;
 *   Step 3 — payment: treasury / exact amount / memo reference with
 *            copy buttons, 5s status polling until activation;
 *   then the active-certificate card (expiry countdown, caps, live
 *   estimated payoff via the range clamp) and the settlement view.
 *
 * All money renders with an explicit "$" and 2–6 decimals through
 * `@/lib/format`, the same helpers the data checkout uses; model figures
 * carry hypothetical/no-advice captions (FR-L3).
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
import { ApiError, apiFetch, errorMessage, retryAtFrom } from "@/lib/api-client";
import {
  formatCountdown,
  formatNumber,
  formatPercent,
  formatTimestamp,
  formatUsdc,
  formatUsdcExact,
  formatUsdcSigned,
  usdcAmountField,
} from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { CopyField } from "@/components/ui/copy-field";
import { RateLimitNotice } from "@/components/ui/rate-limit-notice";

type Phase =
  | "idle" //     panel closed, nothing loaded
  | "loading" //  quote request in flight
  | "error" //    quote request failed (message shown)
  | "quote" //    step 1
  | "consent" //  step 2
  | "payment" //  step 3 — polling for activation
  | "active" //   certificate active — polling for settlement
  | "done"; //    settled or expired

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
      <p className="lh-fact-value">{value}</p>
      {sub && <p className="lh-fact-sub">{sub}</p>}
    </div>
  );
}

function Term({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Linear interpolation of the position's V(S) curve at a given price. */
function interpolateCurve(
  curve: ValueCurvePoint[],
  price: number,
): number | null {
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
 * Outside the range the contractual caps apply exactly.
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
  // Set when /api/hedge/quote answered 429 (10 quotes a minute).
  const [retryAtTs, setRetryAtTs] = useState<number | null>(null);
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
    setRetryAtTs(null);
    setDevNote(null);
    setCertificate(null);
    try {
      const payload = await apiFetch<HedgeQuoteResponse>("/api/hedge/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, positionMint: position.positionMint }),
      });
      setQuote(payload.quote);
      setPayment(payload.paymentInstructions);
      setConsentItems(payload.consentItems);
      setChecks(new Array(payload.consentItems.length).fill(false));
      setPhase("quote");
    } catch (err) {
      setRetryAtTs(retryAtFrom(err));
      setError(errorMessage(err, "Failed to request a quote."));
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
      } else if (res.status === 503 || res.status === 429) {
        if (res.status === 429) {
          const wait = Number(res.headers.get("Retry-After"));
          setRetryAtTs(
            Math.floor(Date.now() / 1000) +
              (Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 60),
          );
        }
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "Hedge service unavailable.",
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
    // Self-scheduling poll so a 429 can widen the interval instead of
    // hammering a limiter that has already said no.
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delayMs = 5000;
      try {
        const body = await apiFetch<HedgeStatusResponse>(
          `/api/hedge/status?quoteId=${encodeURIComponent(quote.quoteId)}`,
        );
        if (cancelled) return;
        applyStatus(body);
      } catch (err) {
        if (err instanceof ApiError && err.isRateLimited) {
          delayMs = (err.retryAfterSeconds ?? 60) * 1000;
        }
        // Any other transient failure — the next tick retries.
      }
      if (!cancelled) timer = setTimeout(poll, delayMs);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
          typeof body?.error === "string"
            ? body.error
            : `Request failed (${res.status})`,
        );
      }
      if (body.activated) {
        setCertificate(body.activated as CertificateRecord);
        setPhase("active");
      } else {
        setDevNote(
          "Payment recorded but no certificate activated (see server log).",
        );
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
          typeof body?.error === "string"
            ? body.error
            : `Request failed (${res.status})`,
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
    <div
      className="lh-card-sub lh-card-dashed lh-btn-row"
      style={{ gap: "0.75rem" }}
    >
      <StatusBadge tone="warning" label="Quote expired" />
      <span className="lh-help">Quote expired — request a new one.</span>
      <button type="button" onClick={requestQuote} className="lh-btn lh-btn-ghost">
        Request new quote
      </button>
    </div>
  );

  const payoffEstimateUsdc =
    quote && certificate?.status === "active"
      ? estimatePayoffUsdc(quote, position.curve, position.price)
      : null;

  return (
    <div style={{ marginTop: "1.25rem" }}>
      {!open ? (
        <button type="button" onClick={openPanel} className="lh-btn lh-btn-ghost">
          Hedge this position
        </button>
      ) : (
        <section className="lh-card-sub" aria-label="Hedge purchase">
          <header className="lh-card-head">
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <h4 className="lh-h3">Liquidity Hedge certificate</h4>
              <span className="lh-card-meta">{STEP_LABELS[phase] ?? ""}</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="lh-btn lh-btn-quiet lh-btn-xs"
            >
              Close
            </button>
          </header>

          <div style={{ marginTop: "1rem" }}>
            {phase === "loading" && (
              <div
                className="lh-skeleton"
                style={{ height: "6rem" }}
                aria-hidden="true"
              />
            )}

            {phase === "error" &&
              (retryAtTs !== null ? (
                <RateLimitNotice
                  retryAtTs={retryAtTs}
                  what="Hedge quotes"
                  onRetry={requestQuote}
                />
              ) : (
                <div className="lh-stack-tight">
                  <p className="lh-error-text" role="alert">
                    {error}
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={requestQuote}
                      className="lh-btn lh-btn-ghost"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ))}

            {phase === "quote" && quote && (
              <div className="lh-stack-tight">
                {quoteExpired ? (
                  expiredNotice
                ) : (
                  <p className="lh-prov">
                    <span>
                      Quote is an offer open for the validity period, then
                      lapses (Master Terms §4.1).
                    </span>
                    <span className="lh-prov-item">
                      <span className="lh-prov-key">valid for</span>
                      {formatCountdown(quoteTtl)}
                    </span>
                  </p>
                )}

                <div className="lh-facts lh-facts-3">
                  <Fact label="Premium" value={formatUsdc(quote.premiumUsdc)} />
                  <Fact
                    label="Collateral (= cap up)"
                    value={formatUsdc(quote.capUpUsdc)}
                  />
                  <Fact
                    label="Total payable now"
                    value={formatUsdc(quote.totalPayableUsdc)}
                    sub="premium + collateral"
                  />
                </div>

                <dl className="lh-dl lh-dl-4">
                  <Term label="Cap down (max paid to you)">
                    {formatUsdc(quote.capDownUsdc)}
                  </Term>
                  <Term label="Cap up (max you can owe, prefunded)">
                    {formatUsdc(quote.capUpUsdc)}
                  </Term>
                  <Term label="Range [p_l, p_u]">
                    {formatNumber(quote.priceLowerUsd)} –{" "}
                    {formatNumber(quote.priceUpperUsd)} USDC
                  </Term>
                  <Term label="Entry price S₀">
                    {formatNumber(quote.entryPriceUsd)} USDC
                  </Term>
                </dl>

                <div>
                  <p className="lh-label-block">
                    Premium breakdown — Premium = max(P_floor, FV · m_vol − y ·
                    E[F])
                  </p>
                  <div className="lh-table-scroll" style={{ marginTop: "0.5rem" }}>
                    <table className="lh-table">
                      <tbody>
                        <tr>
                          <td>FV — fair value (risk-neutral GBM)</td>
                          <td className="lh-td-num">
                            {formatUsdc(quote.breakdown.fairValueUsdc)}
                          </td>
                        </tr>
                        <tr>
                          <td>m_vol — volatility markup (max of floor, IV/RV)</td>
                          <td className="lh-td-num">
                            ×{quote.breakdown.effectiveMarkup.toFixed(4)}
                          </td>
                        </tr>
                        <tr>
                          <td>− y · E[F] — fee-split discount</td>
                          <td className="lh-td-num">
                            −{formatUsdc(quote.breakdown.feeDiscountUsdc)}
                          </td>
                        </tr>
                        <tr>
                          <td>P_floor — minimum premium</td>
                          <td className="lh-td-num">
                            {formatUsdc(quote.breakdown.premiumFloorUsdc)}
                          </td>
                        </tr>
                        <tr>
                          <td>σ — annualized realized vol</td>
                          <td className="lh-td-num">
                            {formatPercent(quote.breakdown.sigmaAnnual)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <CopyField
                  label="Term sheet hash (SHA-256)"
                  display={quote.termSheetHash}
                  copyValue={quote.termSheetHash}
                  help="Shown before acceptance, anchored at activation — the terms you accepted stay identifiable afterwards."
                />

                {!quoteExpired && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setPhase("consent")}
                      className="lh-btn"
                    >
                      Continue to acknowledgments
                    </button>
                  </div>
                )}
              </div>
            )}

            {phase === "consent" && quote && (
              <div className="lh-stack-tight">
                {quoteExpired && expiredNotice}
                <p className="lh-help">
                  Each acknowledgment below is required and is recorded with a
                  timestamp at purchase.
                </p>
                <div className="lh-stack-tight">
                  {consentItems.map((text, i) => (
                    <label key={i} className="lh-check">
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
                      />
                      <span>{text}</span>
                    </label>
                  ))}
                </div>
                <div className="lh-callout" data-tone="quiet">
                  <p>{JURISDICTION_ATTESTATION}</p>
                </div>
                <div className="lh-btn-row">
                  <button
                    type="button"
                    onClick={() => setPhase("quote")}
                    className="lh-btn lh-btn-quiet"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!allChecked || quoteExpired}
                    onClick={() => setPhase("payment")}
                    className="lh-btn"
                  >
                    Continue to payment
                  </button>
                </div>
              </div>
            )}

            {phase === "payment" && quote && payment && (
              <div className="lh-stack-tight">
                {quoteExpired ? (
                  expiredNotice
                ) : (
                  <p className="lh-prov" role="status">
                    <span className="lh-prov-item">
                      <span className="lh-prov-key">checking</span>
                      the chain for your payment every 5 seconds
                    </span>
                    <span className="lh-prov-item">
                      <span className="lh-prov-key">quote valid for</span>
                      {formatCountdown(quoteTtl)}
                    </span>
                  </p>
                )}

                <CopyField
                  label="Treasury address (pay to)"
                  display={payment.treasuryAddress}
                  copyValue={payment.treasuryAddress}
                />
                <CopyField
                  label="Amount, USDC"
                  display={usdcAmountField(payment.amountUsdc)}
                  copyValue={usdcAmountField(payment.amountUsdc)}
                  help={`Exactly ${formatUsdcExact(payment.amountUsdc)} — premium plus collateral.`}
                />
                <CopyField
                  label="Memo reference (must accompany the transfer)"
                  display={payment.memoReference}
                  copyValue={payment.memoReference}
                />

                <div className="lh-callout">
                  <p className="lh-callout-h">Send it exactly</p>
                  <p>
                    Send exactly this amount in USDC with exactly this memo. Any
                    other transfer cannot activate the certificate and is
                    refunded per Master Terms §4.4.
                  </p>
                </div>

                <div className="lh-btn-row">
                  <button
                    type="button"
                    onClick={() => setPhase("consent")}
                    className="lh-btn lh-btn-quiet"
                  >
                    Back
                  </button>
                  {devMode && !quoteExpired && (
                    <button
                      type="button"
                      onClick={simulatePayment}
                      disabled={devBusy}
                      className="lh-btn lh-btn-ghost"
                    >
                      {devBusy ? "Working…" : "Simulate payment (dev)"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {phase === "active" && quote && certificate && (
              <div className="lh-stack-tight">
                <div className="lh-btn-row">
                  <StatusBadge tone="good" label="Certificate active" />
                  <span className="lh-card-meta">
                    expires in {formatCountdown(certificate.expiryTs - nowTs)} (
                    {formatTimestamp(certificate.expiryTs)})
                  </span>
                </div>

                <div className="lh-facts lh-facts-4">
                  <Fact
                    label="Estimated payoff Π (now)"
                    value={
                      payoffEstimateUsdc === null
                        ? "unavailable"
                        : formatUsdcSigned(payoffEstimateUsdc)
                    }
                    sub={`at ${formatNumber(position.price)} USDC`}
                  />
                  <Fact
                    label="Cap down (max to you)"
                    value={formatUsdc(certificate.capDownUsdc)}
                  />
                  <Fact
                    label="Cap up (covered by collateral)"
                    value={formatUsdc(certificate.capUpUsdc)}
                  />
                  <Fact
                    label="Premium paid"
                    value={formatUsdc(certificate.premiumUsdc)}
                  />
                </div>

                <p className="lh-note">
                  Estimated from the current dashboard price via the range clamp
                  Π = V(S₀) − V(clamp(S, p_l, p_u)) — hypothetical, not a
                  prediction and not investment advice. Settlement uses the
                  Master Terms §7.1 price policy at expiry.
                </p>

                {devMode && (
                  <div>
                    <button
                      type="button"
                      onClick={settleDue}
                      disabled={devBusy}
                      className="lh-btn lh-btn-ghost"
                    >
                      {devBusy ? "Working…" : "Settle due (dev)"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {phase === "done" && certificate?.settlement && (
              <div className="lh-stack-tight">
                <div className="lh-btn-row">
                  <StatusBadge
                    tone="good"
                    label={
                      certificate.status === "settled"
                        ? "Settled"
                        : "Expired (Π = 0)"
                    }
                  />
                  <span className="lh-card-meta">
                    settled{" "}
                    {formatTimestamp(certificate.settlement.settledAtTs)}
                  </span>
                </div>

                <div className="lh-facts lh-facts-4">
                  <Fact
                    label="Settlement price S_T"
                    value={`${formatNumber(certificate.settlement.settlementPriceUsd)} USDC`}
                  />
                  <Fact
                    label="Payoff Π"
                    value={formatUsdcSigned(certificate.settlement.payoffUsdc)}
                  />
                  <Fact
                    label="Fee split"
                    value={formatUsdc(certificate.settlement.feeSplitUsdc)}
                  />
                  <Fact
                    label="Paid to you (§7.2)"
                    value={formatUsdc(
                      certificate.settlement.settlementAmountUsdc,
                    )}
                    sub="max(0, Π − fee split + collateral)"
                  />
                </div>

                <div>
                  <button
                    type="button"
                    onClick={requestQuote}
                    className="lh-btn lh-btn-ghost"
                  >
                    Request a new quote
                  </button>
                </div>
              </div>
            )}
          </div>

          {devNote && (
            <p className="lh-help" role="status" style={{ marginTop: "0.75rem" }}>
              {devNote}
            </p>
          )}

          <p
            className="lh-note"
            style={{
              marginTop: "1rem",
              paddingTop: "0.75rem",
              borderTop: "1px solid var(--lh-rule)",
            }}
          >
            A certificate is a bilateral contract with Blocksventures Ltd. as
            your sole counterparty — not insurance, not a deposit, not custody.
            Figures shown are model output — hypothetical, not a prediction and
            not investment advice.
          </p>
        </section>
      )}
    </div>
  );
}
