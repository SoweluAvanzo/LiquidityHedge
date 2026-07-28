"use client";

/**
 * Data-product checkout.
 *
 *   Step 1 — Choose:  the two datasets at their real prices, the pre-order
 *                     labelled as not-yet-collected, email required for it;
 *   Step 2 — Pay:     wallet-signed (the wallet's own dialog is the
 *                     confirmation) or manual, with the exact tagged
 *                     amount, recipient, memo and Solana Pay URL;
 *   Step 3 — Receive: 5-second polling of the server's on-chain check,
 *                     then the single-use download grant, the pre-order
 *                     email notice, or what happens on expiry/refund.
 *
 * Two rules this component never bends:
 *  - it never asserts payment. `/api/data/status` reads the chain itself
 *    at finalized commitment and is the only thing that can move an order
 *    forward; this UI can ask it to look again, nothing more;
 *  - it never touches funds. The wallet path only PROPOSES a transaction;
 *    the user approves it in their own wallet, and the recipient address
 *    is externally managed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { buildPaymentInstructions } from "@lh/commerce";

import {
  ApiError,
  apiFetch,
  errorMessage,
  retryAtFrom,
} from "@/lib/api-client";
import {
  DATA_PRODUCTS,
  DATA_STATUS_LABEL,
  DATA_STATUS_TONE,
  DATA_TAG_SPACE,
  type DataOrderResponse,
  type DataProductId,
  type DataStatusResponse,
} from "@/lib/data-api";
import {
  formatCountdown,
  formatTimestamp,
  formatUsdcExact,
  shortenAddress,
  usdcAmountField,
} from "@/lib/format";
import { CONTACT_EMAIL, LEGAL_ENTITY } from "@/lib/site";
import { StatusBadge } from "@/components/status-badge";
import { CopyButton, CopyField } from "@/components/ui/copy-field";
import {
  RateLimitNotice,
  useSecondsUntil,
} from "@/components/ui/rate-limit-notice";

type PayTab = "wallet" | "manual";

const STEPS = [
  { n: "01", name: "Choose" },
  { n: "02", name: "Pay" },
  { n: "03", name: "Receive" },
];

/** The mint the server quoted, read back from the Solana Pay URL. */
function splTokenOf(solanaPayUrl: string): string | null {
  try {
    return new URL(solanaPayUrl).searchParams.get("spl-token");
  } catch {
    return null;
  }
}

function StepRail({ index }: { index: 0 | 1 | 2 }) {
  return (
    <ol className="lh-steps">
      {STEPS.map((step, i) => (
        <li
          key={step.n}
          className="lh-step"
          data-state={i === index ? "current" : i < index ? "done" : "todo"}
          aria-current={i === index ? "step" : undefined}
        >
          <span className="lh-step-n">
            {step.n}
            {i < index ? " · done" : ""}
          </span>
          <p className="lh-step-name">{step.name}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * The payable amount, with its order tag set apart.
 *
 * The server adds a random per-order value (up to ~$0.066) to the list
 * price, so a transfer that carries no reference key can still be bound to
 * exactly one order. Those digits are the load-bearing part of the number,
 * so they are marked rather than buried in the decimals. The split is the
 * first digit at which the quoted amount departs from the list price; if
 * the amount does not look tagged, nothing is marked.
 */
function TaggedAmount({
  amountUsdc,
  basePriceUsdc,
}: {
  amountUsdc: number;
  basePriceUsdc: number;
}) {
  const field = usdcAmountField(amountUsdc);
  const base = usdcAmountField(basePriceUsdc);
  const delta = amountUsdc - basePriceUsdc;
  const tagged =
    delta > 0 && delta < DATA_TAG_SPACE && field.length === base.length;
  let split = field.length;
  if (tagged) {
    split = 0;
    while (split < field.length && field[split] === base[split]) split++;
  }
  return (
    <p className="lh-amount">
      {field.slice(0, split)}
      {split < field.length && (
        <span className="lh-amount-tag">{field.slice(split)}</span>
      )}
      <span className="lh-amount-unit">USDC</span>
    </p>
  );
}

export function DataCheckout() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  // Step 1
  const [productId, setProductId] = useState<DataProductId>(
    "dataset-2026-forward",
  );
  const [email, setEmail] = useState("");
  // The licence and pre-order acknowledgments — both required before an
  // order exists, so nobody pays before reading what they are buying.
  const [acceptedLicence, setAcceptedLicence] = useState(false);
  const [acceptedPreOrder, setAcceptedPreOrder] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // 429: asking again before this passes is futile.
  const [retryAtTs, setRetryAtTs] = useState<number | null>(null);
  // 503: data sales are switched off on this deployment.
  const [unavailable, setUnavailable] = useState<string | null>(null);

  // Step 2/3
  const [order, setOrder] = useState<DataOrderResponse | null>(null);
  const [status, setStatus] = useState<DataStatusResponse | null>(null);
  const [tab, setTab] = useState<PayTab>("manual");
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  // AUDIT #9: the grant used to be returned exactly once and held only in
  // React state, so closing the tab forfeited a paid file permanently. The
  // claim secret is now persisted for the session and can re-fetch a fresh
  // grant; sessionStorage (not localStorage) so it dies with the tab
  // rather than lingering on a shared machine.
  const [downloadToken, setDownloadToken] = useState<string | null>(null);
  const [downloadExpiresAtTs, setDownloadExpiresAtTs] = useState<number | null>(
    null,
  );
  // Set while the status poll is backing off after a 429.
  const [pollPausedUntilTs, setPollPausedUntilTs] = useState<number | null>(null);

  const [nowTs, setNowTs] = useState(() => Math.floor(Date.now() / 1000));
  const emailRef = useRef<HTMLInputElement | null>(null);

  const product = useMemo(
    () => DATA_PRODUCTS.find((p) => p.id === productId) ?? DATA_PRODUCTS[0],
    [productId],
  );

  const consentComplete =
    acceptedLicence && (!product.requiresEmail || acceptedPreOrder);

  // Hook, so it must sit above the early return for the product step.
  const pollPaused = useSecondsUntil(pollPausedUntilTs);

  const effectiveStatus = status?.status ?? "awaiting-payment";
  const awaiting = !!order && effectiveStatus === "awaiting-payment";
  const stepIndex: 0 | 1 | 2 = !order
    ? 0
    : effectiveStatus === "awaiting-payment"
      ? 1
      : 2;

  // Wallet payment is only offered when a wallet is actually connected.
  useEffect(() => {
    if (connected) setTab("wallet");
  }, [connected]);

  // 1s ticker for the order-expiry countdown (only while it matters).
  useEffect(() => {
    if (!awaiting) return;
    const timer = setInterval(
      () => setNowTs(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [awaiting]);

  // Persist the claim secret the moment the order comes back.
  useEffect(() => {
    if (!order?.claimSecret) return;
    try {
      sessionStorage.setItem(`lh.claim.${order.orderId}`, order.claimSecret);
    } catch {
      /* private mode / storage disabled — polling still works this session */
    }
  }, [order]);

  const claimFor = useCallback((orderId: string): string => {
    try {
      return sessionStorage.getItem(`lh.claim.${orderId}`) ?? "";
    } catch {
      return "";
    }
  }, []);

  const applyStatus = useCallback((body: DataStatusResponse) => {
    setStatus(body);
    if (body.downloadToken) {
      setDownloadToken(body.downloadToken);
      setDownloadExpiresAtTs(body.downloadExpiresAtTs);
    }
  }, []);

  /*
   * 5s polling of the server's own on-chain check, while awaiting payment.
   *
   * Self-scheduling rather than a fixed interval: when the limiter answers
   * 429 the next attempt waits for the window it names instead of adding
   * to the pile. Polling asks the server to look at the chain again — it
   * can never assert that a payment happened.
   */
  useEffect(() => {
    if (!order || !awaiting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delayMs = 5000;
      try {
        const body = await apiFetch<DataStatusResponse>(
          `/api/data/status?orderId=${encodeURIComponent(order.orderId)}` +
            `&claim=${encodeURIComponent(claimFor(order.orderId))}`,
        );
        if (cancelled) return;
        setPollPausedUntilTs(null);
        applyStatus(body);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.isRateLimited) {
          const wait = err.retryAfterSeconds ?? 60;
          delayMs = wait * 1000;
          setPollPausedUntilTs(Math.floor(Date.now() / 1000) + wait);
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
  }, [order, awaiting, applyStatus, claimFor]);

  const createOrder = async () => {
    if (creating) return;
    if (product.requiresEmail && email.trim() === "") {
      setCreateError(
        "An email address is required for the pre-order — it is the only delivery channel.",
      );
      emailRef.current?.focus();
      return;
    }
    setCreating(true);
    setCreateError(null);
    setRetryAtTs(null);
    try {
      const body = await apiFetch<DataOrderResponse>("/api/data/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          ...(publicKey ? { buyerWallet: publicKey.toBase58() } : {}),
          ...(email.trim() !== "" ? { email: email.trim() } : {}),
        }),
      });
      setOrder(body);
      setStatus(null);
      setTxSignature(null);
      setPayError(null);
    } catch (err) {
      if (err instanceof ApiError && err.isUnavailable) {
        setUnavailable(err.message);
      } else {
        setRetryAtTs(retryAtFrom(err));
        setCreateError(errorMessage(err, "Could not create the order."));
      }
    } finally {
      setCreating(false);
    }
  };

  const payWithWallet = async () => {
    if (!order || !publicKey || paying) return;
    const mint = splTokenOf(order.payment.solanaPayUrl);
    if (!mint) {
      setPayError(
        "The quoted payment is missing its token mint. Pay manually instead.",
      );
      return;
    }
    setPaying(true);
    setPayError(null);
    try {
      const instructions = buildPaymentInstructions({
        buyerWallet: publicKey,
        revenueWallet: new PublicKey(order.payment.recipient),
        usdcMint: new PublicKey(mint),
        amountUsdc: order.amountUsdc,
        reference: new PublicKey(order.payment.reference),
        memo: order.payment.memo,
      });
      const transaction = new Transaction().add(...instructions);
      const signature = await sendTransaction(transaction, connection);
      setTxSignature(signature);
    } catch (err) {
      setPayError(
        err instanceof Error
          ? err.message
          : "The wallet did not send the transaction.",
      );
    } finally {
      setPaying(false);
    }
  };

  const reset = () => {
    setOrder(null);
    setStatus(null);
    setTxSignature(null);
    setPayError(null);
    setDownloadToken(null);
    setDownloadExpiresAtTs(null);
    setPollPausedUntilTs(null);
    setRetryAtTs(null);
    // A new purchase is a new acknowledgment.
    setAcceptedLicence(false);
    setAcceptedPreOrder(false);
  };

  // ── step 1 — choose ───────────────────────────────────────────────
  if (!order) {
    return (
      <div className="lh-stack">
        <StepRail index={0} />

        <section className="lh-card" aria-labelledby="choose-h">
          <div className="lh-card-head">
            <h2 className="lh-h2" id="choose-h">
              Choose a dataset
            </h2>
            <span className="lh-card-meta">paid in USDC on Solana</span>
          </div>

          <div className="lh-picker" style={{ marginTop: "1rem" }} role="group" aria-labelledby="choose-h">
            {DATA_PRODUCTS.map((p) => (
              <label className="lh-option" key={p.id}>
                <span className="lh-option-head">
                  <input
                    type="radio"
                    name="product"
                    value={p.id}
                    checked={productId === p.id}
                    onChange={() => setProductId(p.id)}
                  />
                  <span className="lh-option-price">
                    {p.price}
                    <span className="lh-option-unit">{p.priceUnit}</span>
                  </span>
                  <StatusBadge tone={p.availabilityTone} label={p.availability} />
                </span>
                <span>
                  <span className="lh-h3">{p.name}</span>
                  <p className="lh-option-body" style={{ marginTop: "0.4rem" }}>
                    {p.summary}
                  </p>
                  <ul className="lh-list">
                    {p.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </span>
              </label>
            ))}
          </div>

          <div
            className="lh-stack-tight"
            style={{ marginTop: "1.25rem", maxWidth: "34rem" }}
          >
            <div className="lh-field">
              <label className="lh-label" htmlFor="checkout-email">
                Email{" "}
                <span className="lh-label-optional">
                  {product.requiresEmail
                    ? "— required for the pre-order"
                    : "— optional, for the receipt"}
                </span>
              </label>
              <input
                id="checkout-email"
                ref={emailRef}
                className="lh-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="you@example.com"
                value={email}
                required={product.requiresEmail}
                aria-describedby="checkout-email-help"
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="lh-help" id="checkout-email-help">
                {product.requiresEmail
                  ? "The archive is reconstructed by hand and delivered by email, so an address is required. Nothing is downloadable today."
                  : "The download is granted in the browser as soon as the payment is verified; an email address only gives you a second copy of the receipt."}
              </p>
            </div>

            <p className="lh-help">
              {publicKey
                ? `Paying from ${shortenAddress(publicKey.toBase58())} — the order will be tagged to that wallet.`
                : "No wallet connected. You can still order and pay manually from any wallet or exchange."}
            </p>

            {/* Consent — what you are agreeing to, before an order exists */}
            <fieldset className="lh-group" style={{ marginTop: "0.25rem" }}>
              <legend className="lh-group-title">Before you order</legend>
              <div className="lh-stack-tight">
                <label className="lh-check">
                  <input
                    type="checkbox"
                    checked={acceptedLicence}
                    onChange={(e) => setAcceptedLicence(e.target.checked)}
                  />
                  <span>
                    I am buying from {LEGAL_ENTITY} (British Virgin Islands)
                    under a licence for internal use by my organisation. I will
                    not redistribute or resell the data, and I understand a
                    delivered file is not refundable.
                  </span>
                </label>
                {product.requiresEmail && (
                  <label className="lh-check">
                    <input
                      type="checkbox"
                      checked={acceptedPreOrder}
                      onChange={(e) => setAcceptedPreOrder(e.target.checked)}
                    />
                    <span>
                      I understand this archive <b>does not exist yet</b>, that
                      it is reconstructed on request, that indicative delivery is
                      4–6 weeks by email, and that nothing is downloadable today.
                    </span>
                  </label>
                )}
              </div>
            </fieldset>

            {unavailable ? (
              <div className="lh-callout" data-tone="alert" role="status">
                <p className="lh-callout-h">Data sales are not available</p>
                <p>
                  {unavailable} This deployment has no revenue address
                  configured, so no order can be quoted and nothing can be
                  paid. Nothing was charged. Write to{" "}
                  <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
                    {CONTACT_EMAIL}
                  </a>{" "}
                  and the dataset will be quoted and delivered by hand.
                </p>
              </div>
            ) : retryAtTs !== null ? (
              <RateLimitNotice
                retryAtTs={retryAtTs}
                what="Order requests"
                onRetry={createOrder}
              />
            ) : (
              createError && (
                <p className="lh-error-text" role="alert">
                  {createError}
                </p>
              )
            )}

            {!unavailable && (
              <div className="lh-btn-row">
                <button
                  type="button"
                  className="lh-btn"
                  onClick={createOrder}
                  disabled={creating || !consentComplete}
                >
                  {creating ? "Creating the order…" : "Create the order"}
                </button>
                <span className="lh-help">
                  {consentComplete
                    ? "Creating an order moves no money. It quotes an exact amount and a payment address."
                    : "Tick the acknowledgments above to continue."}
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  // ── steps 2 and 3 — pay and receive ───────────────────────────────
  const secondsLeft = order.expiresAtTs - nowTs;
  const expired = effectiveStatus === "expired" || (awaiting && secondsLeft <= 0);
  const tone = DATA_STATUS_TONE[expired ? "expired" : effectiveStatus];
  const label = DATA_STATUS_LABEL[expired ? "expired" : effectiveStatus];

  return (
    <div className="lh-stack">
      <StepRail index={stepIndex} />

      <section className="lh-card" aria-labelledby="order-h">
        <div className="lh-card-head">
          <h2 className="lh-h2" id="order-h">
            {order.productName}
          </h2>
          <StatusBadge tone={tone} label={label} />
        </div>

        <dl className="lh-facts lh-facts-4" style={{ marginTop: "1rem" }}>
          <div className="lh-fact">
            <dt className="lh-fact-label">Order</dt>
            <dd className="lh-fact-value">{order.orderId}</dd>
          </div>
          <div className="lh-fact">
            <dt className="lh-fact-label">Amount due</dt>
            <dd className="lh-fact-value">{formatUsdcExact(order.amountUsdc)}</dd>
          </div>
          <div className="lh-fact">
            <dt className="lh-fact-label">
              {awaiting && !expired ? "Order expires in" : "Order expiry"}
            </dt>
            <dd className="lh-fact-value">
              {awaiting && !expired
                ? formatCountdown(secondsLeft)
                : formatTimestamp(order.expiresAtTs)}
            </dd>
          </div>
          <div className="lh-fact">
            <dt className="lh-fact-label">Delivery</dt>
            <dd className="lh-fact-value" style={{ fontSize: "0.8125rem" }}>
              {order.preOrder ? "By email, 4–6 weeks" : "Download, on payment"}
            </dd>
          </div>
        </dl>

        {/* B1: covered period + exact row count, quoted BEFORE payment
            from the same table the download streams from. */}
        {!order.preOrder && (
          <div className="lh-callout" data-tone="quiet" style={{ marginTop: "1rem" }}>
            <p className="lh-callout-h">What you get, as of this order</p>
            {order.coverage ? (
              <p>
                <b>{order.coverage.rows.toLocaleString("en-US")}</b> rows across{" "}
                <b>{order.coverage.pools}</b> pools, covering{" "}
                {order.coverage.firstT
                  ? formatTimestamp(order.coverage.firstT)
                  : "—"}{" "}
                to{" "}
                {order.coverage.lastT ? formatTimestamp(order.coverage.lastT) : "—"}{" "}
                (UTC). The download contains at least these rows — collection
                continues until you download.
              </p>
            ) : (
              <p>
                Coverage could not be quoted right now (store unreachable). The
                row count is stated in the download itself; nothing is inferred.
              </p>
            )}
          </div>
        )}

        {status?.note && (
          <div className="lh-callout" data-tone="quiet" style={{ marginTop: "1rem" }}>
            <p className="lh-callout-h">From the chain check</p>
            <p>{status.note}</p>
          </div>
        )}

        {/* ── fulfilled: the one-shot download grant ── */}
        {effectiveStatus === "fulfilled" && (
          <div className="lh-callout" data-tone="range" style={{ marginTop: "1.25rem" }}>
            <p className="lh-callout-h">Payment verified on-chain</p>
            {downloadToken ? (
              <>
                <p>
                  Your download is ready. The link works once and expires
                  {downloadExpiresAtTs
                    ? ` at ${formatTimestamp(downloadExpiresAtTs)}`
                    : " shortly"}
                  . Save the file when it arrives — requesting it again needs a
                  new grant.
                </p>
                <div className="lh-btn-row" style={{ marginTop: "0.85rem" }}>
                  <a
                    className="lh-btn"
                    href={`/api/data/download?orderId=${encodeURIComponent(order.orderId)}&token=${encodeURIComponent(downloadToken)}`}
                    download
                  >
                    Download the CSV
                  </a>
                  <span className="lh-help">
                    Order {order.orderId} · if the download fails, write to{" "}
                    <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
                      {CONTACT_EMAIL}
                    </a>{" "}
                    quoting the order id — the payment is on-chain and
                    verifiable.
                  </span>
                </div>
              </>
            ) : (
              <p>
                This order is already fulfilled and its download grant has been
                issued. A grant is shown exactly once. Write to{" "}
                <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
                  {CONTACT_EMAIL}
                </a>{" "}
                quoting order {order.orderId} for a replacement.
              </p>
            )}
          </div>
        )}

        {/* ── paid pre-order: manual delivery ── */}
        {effectiveStatus === "paid" && (
          <div className="lh-callout" data-tone="range" style={{ marginTop: "1.25rem" }}>
            <p className="lh-callout-h">Payment received</p>
            <p>
              {order.preOrder
                ? "Delivery is by email within 4–6 weeks. The archive is reconstructed by replaying archived Solana swap transactions; you will be told when reconstruction starts."
                : "The payment is recorded. The download grant is issued on the next status check — this page is already asking."}
            </p>
          </div>
        )}

        {/* ── refund due ── */}
        {effectiveStatus === "refund-due" && (
          <div className="lh-callout" data-tone="alert" style={{ marginTop: "1.25rem" }}>
            <p className="lh-callout-h">Refund due</p>
            <p>
              A payment was seen that this order could not accept — most often a
              transfer that arrived after expiry, or an amount that did not
              match. Nothing was delivered. Write to{" "}
              <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
                {CONTACT_EMAIL}
              </a>{" "}
              with order {order.orderId} and the transaction signature, and the
              funds are returned to the sending address.
            </p>
          </div>
        )}

        {/* ── expired ── */}
        {expired && (
          <div className="lh-callout" style={{ marginTop: "1.25rem" }}>
            <p className="lh-callout-h">Order expired</p>
            <p>
              No payment was seen before this order lapsed, and nothing was
              charged. Start a new order to get a fresh amount and reference. If
              you have already sent funds, write to{" "}
              <a className="lh-inline-link" href={`mailto:${CONTACT_EMAIL}`}>
                {CONTACT_EMAIL}
              </a>{" "}
              with order {order.orderId} and the transaction signature.
            </p>
          </div>
        )}

        {/* ── awaiting payment: the two ways to pay ── */}
        {awaiting && !expired && (
          <div style={{ marginTop: "1.5rem" }}>
            <div
              className="lh-seg"
              role="tablist"
              aria-label="How to pay"
            >
              <button
                type="button"
                role="tab"
                id="tab-wallet"
                aria-selected={tab === "wallet"}
                aria-controls="panel-wallet"
                className="lh-seg-btn"
                onClick={() => setTab("wallet")}
              >
                Pay with wallet
              </button>
              <button
                type="button"
                role="tab"
                id="tab-manual"
                aria-selected={tab === "manual"}
                aria-controls="panel-manual"
                className="lh-seg-btn"
                onClick={() => setTab("manual")}
              >
                Pay manually
              </button>
            </div>

            {tab === "wallet" && (
              <div
                id="panel-wallet"
                role="tabpanel"
                aria-labelledby="tab-wallet"
                className="lh-stack-tight"
                style={{ marginTop: "1rem" }}
              >
                {connected && publicKey ? (
                  <>
                    <p className="lh-p" style={{ marginTop: 0 }}>
                      This builds a USDC transfer of{" "}
                      <b>{formatUsdcExact(order.amountUsdc)}</b> from{" "}
                      <span className="lh-num">
                        {shortenAddress(publicKey.toBase58())}
                      </span>{" "}
                      to the revenue address, carrying this order&rsquo;s
                      reference key and memo. <b>Your wallet&rsquo;s own
                      signing dialog is the confirmation</b> — nothing leaves
                      your wallet until you approve it there, and this site
                      never signs on your behalf.
                    </p>
                    <div className="lh-btn-row">
                      <button
                        type="button"
                        className="lh-btn"
                        onClick={payWithWallet}
                        disabled={paying}
                      >
                        {paying
                          ? "Waiting for your wallet…"
                          : "Approve in your wallet"}
                      </button>
                      <span className="lh-help">
                        Network fees are paid in SOL by your wallet.
                      </span>
                    </div>
                    {payError && (
                      <p className="lh-error-text" role="alert">
                        {payError} You can still pay manually — the amount and
                        address are on the other tab.
                      </p>
                    )}
                    {txSignature && (
                      <CopyField
                        label="Transaction signature"
                        display={txSignature}
                        copyValue={txSignature}
                        help="Sent. Delivery still waits for the server's own on-chain check at finalized commitment — that check, not this signature, is what releases the file."
                      />
                    )}
                  </>
                ) : (
                  <p className="lh-p" style={{ marginTop: 0 }}>
                    No wallet is connected. Connect one from the header to pay
                    in the browser, or use <b>Pay manually</b> to send from any
                    wallet or exchange.
                  </p>
                )}
              </div>
            )}

            {tab === "manual" && (
              <div
                id="panel-manual"
                role="tabpanel"
                aria-labelledby="tab-manual"
                className="lh-stack-tight"
                style={{ marginTop: "1rem" }}
              >
                <div className="lh-card-sub">
                  <p className="lh-label-block" style={{ marginBottom: "0.5rem" }}>
                    Send exactly this amount
                  </p>
                  <TaggedAmount
                    amountUsdc={order.amountUsdc}
                    basePriceUsdc={product.basePriceUsdc}
                  />
                  <p className="lh-help" style={{ marginTop: "0.6rem" }}>
                    The underlined digits are this order&rsquo;s tag — the odd
                    cents that tell your transfer apart from everyone
                    else&rsquo;s. They are how a payment arriving without a
                    reference key is matched to your order, so the amount must
                    arrive exactly as shown: <b>do not round</b>. A different
                    amount cannot be credited and has to be refunded by hand.
                  </p>
                </div>

                <CopyField
                  label="Amount, USDC"
                  display={usdcAmountField(order.amountUsdc)}
                  copyValue={usdcAmountField(order.amountUsdc)}
                  help="The bare decimal a wallet's amount field expects — the same number as above, without the currency symbol."
                />
                <CopyField
                  label="Recipient address (pay to)"
                  display={order.payment.recipient}
                  copyValue={order.payment.recipient}
                  help="Externally managed, receive-only. This site holds no key for it."
                />
                <CopyField
                  label="Memo (include it verbatim)"
                  display={order.payment.memo}
                  copyValue={order.payment.memo}
                  help="Helpful but not required. A payment carrying the Solana Pay reference is matched instantly; one without it — an exchange withdrawal, say — is matched by its exact amount on the next sweep of the revenue wallet, usually within a minute."
                />
                <CopyField
                  label="Solana Pay link"
                  display={order.payment.solanaPayUrl}
                  copyValue={order.payment.solanaPayUrl}
                  help="Open in wallet hands this link to an app that has registered the solana: link type — usually a phone with Phantom or Solflare, which then fills in every field above. If tapping it does nothing, no app on this device handles the link: copy the three fields above instead."
                >
                  <a
                    className="lh-btn lh-btn-ghost lh-btn-xs"
                    href={order.payment.solanaPayUrl}
                  >
                    Open in wallet
                  </a>
                </CopyField>

                <div className="lh-callout">
                  <p className="lh-callout-h">Before you send</p>
                  <p>
                    Send USDC on Solana only, to the address above, in one
                    transfer. A transfer that arrives after the order expires,
                    or in the wrong amount, is a refund case rather than a
                    delivery.
                  </p>
                </div>
              </div>
            )}

            <p className="lh-prov" style={{ marginTop: "1.25rem" }} role="status">
              <span className="lh-prov-key">checking</span>
              {pollPaused > 0 ? (
                <span>
                  paused — the status endpoint is rate limited; resuming in{" "}
                  {pollPaused} second{pollPaused === 1 ? "" : "s"}. Your payment
                  is unaffected; the chain is the record either way.
                </span>
              ) : (
                <span>
                  the chain every 5 seconds for a finalized transfer of{" "}
                  {formatUsdcExact(order.amountUsdc)} carrying reference{" "}
                  {shortenAddress(order.payment.reference)}
                </span>
              )}
              <CopyButton
                value={order.payment.reference}
                label="reference key"
              />
            </p>
          </div>
        )}

        <div className="lh-btn-row" style={{ marginTop: "1.5rem" }}>
          <button type="button" className="lh-btn lh-btn-quiet" onClick={reset}>
            {expired || effectiveStatus === "fulfilled"
              ? "Start another order"
              : "Cancel and start over"}
          </button>
        </div>
      </section>
    </div>
  );
}
