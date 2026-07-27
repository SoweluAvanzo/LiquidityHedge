/**
 * Certificate ledger — the implementation twin of the verified model
 * (platform/formal/lh_ledger.qnt). Every public method corresponds to a
 * model action; every committed transition appends an audit event and
 * re-checks invariants I1–I4 (see invariants.ts). Settlement has NO
 * paused guard — I5 by construction.
 */

import { positionValueAtPrice } from "@lh/portfolio";
import {
  assertUsdcInt,
  CertificateRecord,
  Clock,
  FeeCheckpoint,
  HedgedPositionInput,
  LedgerConfig,
  LedgerError,
  LedgerState,
  MarketInputs,
  ObservedTransfer,
  PaymentRecord,
  QuoteRecord,
  SettlementPriceReading,
} from "./types";
import { assertInvariants, netReserves, activeCapDown, checkInvariants } from "./invariants";
import { priceCertificate, positionGeometry } from "./pricing";
import { buildTermSheet, termSheetHash } from "./term-sheet";

export type LedgerEvent =
  | { kind: "LedgerOpened"; ts: number; initialReservesUsdc: number }
  | { kind: "QuoteIssued"; ts: number; quote: QuoteRecord }
  | { kind: "QuoteLapsed"; ts: number; quoteId: string }
  | { kind: "PaymentObserved"; ts: number; payment: PaymentRecord }
  | { kind: "CertificateActivated"; ts: number; cert: CertificateRecord; txSignature: string }
  | { kind: "FeeCheckpointRecorded"; ts: number; quoteId: string; checkpoint: FeeCheckpoint }
  | { kind: "PaymentRefunded"; ts: number; txSignature: string; amountUsdc: number; reason: string }
  | {
      kind: "CertificateSettled";
      ts: number;
      quoteId: string;
      reading: SettlementPriceReading;
      payoffUsdc: number;
      feeSplitUsdc: number;
      settlementAmountUsdc: number;
      finalStatus: "settled" | "expired";
    }
  | { kind: "PausedSet"; ts: number; paused: boolean };

export interface IdSource {
  quoteId(): string;
  referenceKey(): string;
}

export class CertificateLedger {
  private state: LedgerState;
  private events: LedgerEvent[] = [];

  constructor(
    private readonly config: LedgerConfig,
    private readonly clock: Clock,
    private readonly ids: IdSource,
    initialReservesUsdc: number,
  ) {
    assertUsdcInt(initialReservesUsdc, "initialReservesUsdc");
    this.state = {
      paused: false,
      initialReservesUsdc,
      treasuryUsdc: initialReservesUsdc,
      totalInUsdc: 0,
      totalSettledUsdc: 0,
      totalRefundedUsdc: 0,
      quotes: new Map(),
      paymentsByTx: new Map(),
      certs: new Map(),
    };
    this.commit({
      kind: "LedgerOpened",
      ts: clock.now(),
      initialReservesUsdc,
    });
  }

  // ── Read side ────────────────────────────────────────────────────
  getState(): Readonly<LedgerState> {
    return this.state;
  }
  getEvents(): readonly LedgerEvent[] {
    return this.events;
  }
  /** FR-A5 monitor hook: current invariant status without throwing. */
  monitor() {
    return {
      invariants: checkInvariants(this.state),
      netReservesUsdc: netReserves(this.state),
      activeExposureUsdc: activeCapDown(this.state),
      paused: this.state.paused,
    };
  }

  private commit(event: LedgerEvent): void {
    // B3: VALIDATE BEFORE APPENDING. Appending first meant a violating
    // event reached the persisted log, and every subsequent boot replayed
    // it and threw again — bricking the ledger permanently until a human
    // hand-edited the file. Asserting first keeps the log always-loadable:
    // the bad transition is rejected and never persisted.
    assertInvariants(this.state);
    // Deep-copy: some events carry records that continue to mutate in
    // state (quote status, payment matching). History must be immutable
    // or replay and Merkle anchoring would silently lie.
    this.events.push(structuredClone(event));
  }

  // ── Model action: setPause ───────────────────────────────────────
  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.commit({ kind: "PausedSet", ts: this.clock.now(), paused });
  }

  // ── Model action: issueQuote ─────────────────────────────────────
  issueQuote(position: HedgedPositionInput, market: MarketInputs): QuoteRecord {
    const now = this.clock.now();
    if (this.state.paused) throw new LedgerError("quoting is paused");
    if (now - market.regimeUpdatedAtTs > this.config.regimeMaxAgeSeconds) {
      throw new LedgerError(
        `regime snapshot stale (${now - market.regimeUpdatedAtTs}s > ${this.config.regimeMaxAgeSeconds}s)`,
      );
    }
    for (const q of this.state.quotes.values()) {
      if (
        q.status === "open" &&
        q.position.positionMint === position.positionMint &&
        now <= q.validUntilTs
      ) {
        throw new LedgerError(`open quote already exists for ${position.positionMint}`);
      }
    }
    for (const c of this.state.certs.values()) {
      if (c.status === "active" && c.positionMint === position.positionMint) {
        throw new LedgerError(`position ${position.positionMint} already protected`);
      }
    }
    // A3: bounded ledger growth — the event log cannot be truncated.
    if (
      this.config.maxLifetimeQuotes > 0 &&
      this.state.quotes.size >= this.config.maxLifetimeQuotes
    ) {
      throw new LedgerError(
        `quote ceiling reached (${this.config.maxLifetimeQuotes}) — ledger compaction required`,
      );
    }
    // A2: cap simultaneous open quotes per owner (griefing guard).
    if (this.config.maxOpenQuotesPerOwner > 0) {
      let open = 0;
      for (const q of this.state.quotes.values()) {
        if (
          q.status === "open" &&
          now <= q.validUntilTs &&
          q.position.ownerWallet === position.ownerWallet
        ) {
          open++;
        }
      }
      if (open >= this.config.maxOpenQuotesPerOwner) {
        throw new LedgerError(
          `too many open quotes for this owner (${open}) — wait for one to lapse`,
        );
      }
    }

    const priced = priceCertificate(position, {
      sigmaAnnual: market.sigmaAnnual,
      ivRvRatio: market.ivRvRatio,
      markupFloor: this.config.markupFloor,
      feeSplitRate: this.config.feeSplitRate,
      expectedDailyFee: this.config.expectedDailyFee,
      premiumFloorUsdc: this.config.premiumFloorUsdc,
      tenorSeconds: this.config.tenorSeconds,
    });

    // E12 headroom guard against NET reserves (quote-time check; repeated
    // at activation).
    const headroomNeeded = activeCapDown(this.state) + priced.capDownUsdc;
    if (headroomNeeded * 10_000 > netReserves(this.state) * this.config.uMaxBps) {
      throw new LedgerError(
        `utilization headroom exceeded: exposure ${headroomNeeded} vs ` +
          `netReserves ${netReserves(this.state)} at uMax ${this.config.uMaxBps}bps`,
      );
    }

    const geometry = positionGeometry(position);
    const quoteId = this.ids.quoteId();
    const referenceKey = this.ids.referenceKey();
    const protocolFeeUsdc = Math.floor(
      (priced.premiumUsdc * this.config.protocolFeeBps) / 10_000,
    );

    const quote: QuoteRecord = {
      quoteId,
      referenceKey,
      position: { ...position, liquidity: position.liquidity.toString() },
      priceLowerUsd: geometry.priceLowerUsd,
      priceUpperUsd: geometry.priceUpperUsd,
      entryPriceUsd: position.currentPriceUsd,
      entryValueUsdc: priced.entryValueUsdc,
      premiumUsdc: priced.premiumUsdc,
      capDownUsdc: priced.capDownUsdc,
      capUpUsdc: priced.capUpUsdc,
      totalPayableUsdc: priced.premiumUsdc + priced.capUpUsdc,
      protocolFeeUsdc,
      breakdown: {
        fairValueUsdc: priced.fairValueUsdc,
        effectiveMarkup: priced.effectiveMarkup,
        feeDiscountUsdc: priced.feeDiscountUsdc,
        premiumFloorUsdc: this.config.premiumFloorUsdc,
        sigmaAnnual: market.sigmaAnnual,
      },
      termSheetHash: "",
      issuedAtTs: now,
      validUntilTs: now + this.config.quoteTtlSeconds,
      status: "open",
    };
    quote.termSheetHash = termSheetHash(buildTermSheet(quote, this.config));

    this.state.quotes.set(quoteId, quote);
    this.commit({ kind: "QuoteIssued", ts: now, quote });
    return quote;
  }

  // ── Model action: lapseQuote ─────────────────────────────────────
  /**
   * Attach the activation-time fee-growth checkpoint to a certificate.
   *
   * Separate from activation because it needs an RPC read, and the ledger
   * is pure. Idempotent: a checkpoint is written once and never revised,
   * so a re-run cannot move the basis the fee share is computed from.
   */
  recordFeeCheckpoint(quoteId: string, checkpoint: FeeCheckpoint): void {
    const cert = this.state.certs.get(quoteId);
    if (!cert || cert.feeCheckpoint) return;
    // Mutate live state as well as committing — every other mutator in
    // this class does both, and commit() only appends to the log.
    cert.feeCheckpoint = checkpoint;
    this.commit({ kind: "FeeCheckpointRecorded", ts: this.clock.now(), quoteId, checkpoint });
  }

  lapseExpiredQuotes(): number {
    const now = this.clock.now();
    let lapsed = 0;
    for (const q of this.state.quotes.values()) {
      if (q.status === "open" && now > q.validUntilTs) {
        q.status = "lapsed";
        this.commit({ kind: "QuoteLapsed", ts: now, quoteId: q.quoteId });
        lapsed++;
      }
    }
    return lapsed;
  }

  // ── Model actions: observePayment (+ activate when it matches) ──
  /**
   * Ingest a FINALIZED inbound transfer. Idempotent on txSignature
   * (re-delivery is a no-op). Records the inflow at observation time
   * (E13), then attempts exactly-once activation.
   */
  observePayment(transfer: ObservedTransfer): {
    accepted: boolean;
    activated?: CertificateRecord;
  } {
    const now = this.clock.now();
    assertUsdcInt(transfer.amountUsdc, "transfer.amountUsdc");
    if (this.state.paymentsByTx.has(transfer.txSignature)) {
      return { accepted: false }; // duplicate delivery — idempotent no-op
    }
    const payment: PaymentRecord = {
      txSignature: transfer.txSignature,
      referenceKey: transfer.referenceKey,
      senderWallet: transfer.senderWallet,
      amountUsdc: transfer.amountUsdc,
      observedAtTs: now,
      matched: false,
    };
    this.state.paymentsByTx.set(payment.txSignature, payment);
    this.state.treasuryUsdc += payment.amountUsdc;
    this.state.totalInUsdc += payment.amountUsdc; // E13: ledger at observation
    this.commit({ kind: "PaymentObserved", ts: now, payment });

    const activated = this.tryActivate(payment);
    return { accepted: true, activated };
  }

  private tryActivate(payment: PaymentRecord): CertificateRecord | undefined {
    const now = this.clock.now();
    if (this.state.paused) return undefined;
    const quote = [...this.state.quotes.values()].find(
      (q) => q.referenceKey === payment.referenceKey,
    );
    if (!quote) return undefined;
    if (quote.status !== "open") return undefined;
    if (now > quote.validUntilTs) return undefined;
    if (payment.amountUsdc !== quote.totalPayableUsdc) return undefined; // exact only
    if (this.state.certs.has(quote.quoteId)) return undefined; // exactly-once
    // SECURITY (A1): the payer MUST be the owner of the hedged position.
    // Payment references are visible to anyone who can see a quote, so
    // without this an attacker could pay first and have the settlement
    // (and the position's protection) assigned to them. A mismatched
    // payer leaves the payment unmatched → refundable.
    if (payment.senderWallet !== quote.position.ownerWallet) return undefined;
    // FR-H9 per-buyer exposure cap (pilot risk budget per wallet).
    if (this.config.perBuyerCapDownLimitUsdc > 0) {
      let buyerExposure = 0;
      for (const c of this.state.certs.values()) {
        if (c.status === "active" && c.buyerWallet === payment.senderWallet) {
          buyerExposure += c.capDownUsdc;
        }
      }
      if (buyerExposure + quote.capDownUsdc > this.config.perBuyerCapDownLimitUsdc) {
        return undefined; // stays unmatched → refundable
      }
    }
    // E12 headroom re-check at activation.
    const headroomNeeded = activeCapDown(this.state) + quote.capDownUsdc;
    if (headroomNeeded * 10_000 > netReserves(this.state) * this.config.uMaxBps) {
      return undefined; // stays unmatched → refundable
    }

    const cert: CertificateRecord = {
      quoteId: quote.quoteId,
      positionMint: quote.position.positionMint,
      // Term sheet names the position owner as Buyer; keep them identical.
      buyerWallet: quote.position.ownerWallet,
      premiumUsdc: quote.premiumUsdc,
      capDownUsdc: quote.capDownUsdc,
      capUpUsdc: quote.capUpUsdc,
      activatedAtTs: now,
      expiryTs: now + this.config.tenorSeconds,
      status: "active",
    };
    payment.matched = true;
    quote.status = "consumed";
    this.state.certs.set(cert.quoteId, cert);
    this.commit({
      kind: "CertificateActivated",
      ts: now,
      cert,
      txSignature: payment.txSignature,
    });
    return cert;
  }

  // ── Model action: refund ─────────────────────────────────────────
  /** Refund a payment that can no longer activate. Returns the amount due
   *  back to the sender (the caller executes the on-chain transfer). */
  refundPayment(txSignature: string): { amountUsdc: number; to: string } {
    const now = this.clock.now();
    const payment = this.state.paymentsByTx.get(txSignature);
    if (!payment) throw new LedgerError(`unknown payment ${txSignature}`);
    if (payment.matched) throw new LedgerError(`payment ${txSignature} already matched`);
    const quote = [...this.state.quotes.values()].find(
      (q) => q.referenceKey === payment.referenceKey,
    );
    const eligible =
      !quote ||
      quote.status !== "open" ||
      now > quote.validUntilTs ||
      payment.amountUsdc !== quote.totalPayableUsdc;
    if (!eligible) {
      throw new LedgerError(
        `payment ${txSignature} still matchable — not refundable yet`,
      );
    }
    payment.matched = true;
    this.state.treasuryUsdc -= payment.amountUsdc;
    this.state.totalRefundedUsdc += payment.amountUsdc;
    this.commit({
      kind: "PaymentRefunded",
      ts: now,
      txSignature,
      amountUsdc: payment.amountUsdc,
      reason: !quote
        ? "unknown reference"
        : payment.amountUsdc !== quote.totalPayableUsdc
          ? "wrong amount"
          : "quote no longer open",
    });
    return { amountUsdc: payment.amountUsdc, to: payment.senderWallet };
  }

  // ── Model action: settle (NO paused guard — I5) ──────────────────
  /**
   * Settle an expired certificate. Payoff is computed decimals-safe from
   * the position stored in the quote, clamped to the caps, and the buyer
   * is paid `max(0, payoff − feeSplit + collateral)` (Master Terms §7.2).
   * Returns the payout instruction for the treasury executor.
   */
  settle(
    quoteId: string,
    reading: SettlementPriceReading,
    feesAccruedUsdc: number,
  ): { settlementAmountUsdc: number; to: string } {
    const now = this.clock.now();
    assertUsdcInt(feesAccruedUsdc, "feesAccruedUsdc");
    const cert = this.state.certs.get(quoteId);
    if (!cert) throw new LedgerError(`unknown certificate ${quoteId}`);
    if (cert.status !== "active") throw new LedgerError(`certificate ${quoteId} not active`);
    if (now < cert.expiryTs) {
      throw new LedgerError(`certificate ${quoteId} not expired (now ${now} < ${cert.expiryTs})`);
    }
    const quote = this.state.quotes.get(quoteId)!;

    // Decimals-safe payoff: Π = V(S₀) − V(clamp(S_T, p_l, p_u)).
    const pos = { ...quote.position, liquidity: BigInt(quote.position.liquidity) };
    const clamped = Math.min(
      Math.max(reading.priceUsd, quote.priceLowerUsd),
      quote.priceUpperUsd,
    );
    const entryValueUsd = quote.entryValueUsdc / 1e6;
    const payoffRaw = Math.trunc(
      (entryValueUsd - positionValueAtPrice(pos, clamped)) * 1e6,
    );
    // Clamp float dust into the contractual bounds.
    const payoffUsdc = Math.min(Math.max(payoffRaw, -cert.capUpUsdc), cert.capDownUsdc);

    const feeSplitUsdc = Math.floor(this.config.feeSplitRate * feesAccruedUsdc);
    const settlementAmountUsdc = Math.max(
      0,
      payoffUsdc - feeSplitUsdc + cert.capUpUsdc,
    );
    if (settlementAmountUsdc > this.state.treasuryUsdc) {
      // Unreachable if I1 holds — kept as the belt to the suspenders.
      throw new LedgerError(`treasury cannot cover settlement ${settlementAmountUsdc}`);
    }

    cert.status = payoffUsdc === 0 ? "expired" : "settled";
    cert.settlement = {
      settlementPriceUsd: reading.priceUsd,
      payoffUsdc,
      feeSplitUsdc,
      settlementAmountUsdc,
      settledAtTs: now,
    };
    this.state.treasuryUsdc -= settlementAmountUsdc;
    this.state.totalSettledUsdc += settlementAmountUsdc;
    this.commit({
      kind: "CertificateSettled",
      ts: now,
      quoteId,
      reading,
      payoffUsdc,
      feeSplitUsdc,
      settlementAmountUsdc,
      finalStatus: cert.status as "settled" | "expired",
    });
    return { settlementAmountUsdc, to: cert.buyerWallet };
  }

  // ── Event-sourced replay (NFR-A1) ────────────────────────────────
  /**
   * Rebuild a ledger from its persisted event log. Events are FACTS —
   * they are applied without re-running business validation, but the
   * invariants are re-checked after every application: a corrupted or
   * tampered log fails loudly instead of loading.
   */
  static fromEvents(
    config: LedgerConfig,
    clock: Clock,
    ids: IdSource,
    events: readonly LedgerEvent[],
  ): CertificateLedger {
    if (events.length === 0 || events[0].kind !== "LedgerOpened") {
      throw new LedgerError("event log must start with LedgerOpened");
    }
    const ledger = new CertificateLedger(
      config,
      clock,
      ids,
      events[0].initialReservesUsdc,
    );
    ledger.events = [structuredClone(events[0]) as LedgerEvent];
    for (const e of events.slice(1)) ledger.applyReplay(e);
    return ledger;
  }

  private applyReplay(e: LedgerEvent): void {
    const s = this.state;
    switch (e.kind) {
      case "LedgerOpened":
        throw new LedgerError("duplicate LedgerOpened in event log");
      case "QuoteIssued":
        s.quotes.set(e.quote.quoteId, structuredClone(e.quote));
        break;
      case "QuoteLapsed": {
        const q = s.quotes.get(e.quoteId);
        if (!q) throw new LedgerError(`replay: unknown quote ${e.quoteId}`);
        q.status = "lapsed";
        break;
      }
      case "PaymentObserved":
        s.paymentsByTx.set(e.payment.txSignature, structuredClone(e.payment));
        s.treasuryUsdc += e.payment.amountUsdc;
        s.totalInUsdc += e.payment.amountUsdc;
        break;
      case "CertificateActivated": {
        s.certs.set(e.cert.quoteId, structuredClone(e.cert));
        const p = s.paymentsByTx.get(e.txSignature);
        const q = s.quotes.get(e.cert.quoteId);
        if (!p || !q) throw new LedgerError(`replay: dangling activation ${e.cert.quoteId}`);
        p.matched = true;
        q.status = "consumed";
        break;
      }
      case "FeeCheckpointRecorded": {
        const cert = s.certs.get(e.quoteId);
        // Write-once: replay must reproduce the original basis exactly.
        if (cert && !cert.feeCheckpoint) cert.feeCheckpoint = e.checkpoint;
        break;
      }
      case "PaymentRefunded": {
        const p = s.paymentsByTx.get(e.txSignature);
        if (!p) throw new LedgerError(`replay: unknown payment ${e.txSignature}`);
        p.matched = true;
        s.treasuryUsdc -= e.amountUsdc;
        s.totalRefundedUsdc += e.amountUsdc;
        break;
      }
      case "CertificateSettled": {
        const c = s.certs.get(e.quoteId);
        if (!c) throw new LedgerError(`replay: unknown certificate ${e.quoteId}`);
        c.status = e.finalStatus;
        c.settlement = {
          settlementPriceUsd: e.reading.priceUsd,
          payoffUsdc: e.payoffUsdc,
          feeSplitUsdc: e.feeSplitUsdc,
          settlementAmountUsdc: e.settlementAmountUsdc,
          settledAtTs: e.ts,
        };
        s.treasuryUsdc -= e.settlementAmountUsdc;
        s.totalSettledUsdc += e.settlementAmountUsdc;
        break;
      }
      case "PausedSet":
        s.paused = e.paused;
        break;
    }
    this.commit(structuredClone(e));
  }

  /** Certificates due for settlement (the settler worker's scan). */
  dueForSettlement(): CertificateRecord[] {
    const now = this.clock.now();
    return [...this.state.certs.values()].filter(
      (c) => c.status === "active" && now >= c.expiryTs,
    );
  }
}
