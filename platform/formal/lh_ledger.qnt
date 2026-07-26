// -*- mode: quint -*-
/**
 * lh_ledger.qnt — Formal model of the LH platform's certificate/payment/
 * settlement ledger (Phase 3, plan §6.3; gate G2).
 *
 * Scope: the MONEY-CRITICAL state machine only — quotes, payment matching,
 * activation, settlement, refunds, pause. The payoff function is abstracted:
 * at settlement the environment picks ANY payoff in [−capUp, +capDown]
 * (the implementation guarantees the clamp; the ledger must be safe for
 * every admissible payoff — a strictly stronger claim than testing V(S)).
 *
 * Units: integer µUSDC throughout. Time: abstract ticks.
 *
 * Invariants checked (quint run / verify, see formal/README.md):
 *   I1 solvencyInv       — reserves cover worst-case obligations under uMax
 *   I2 noDoubleActivation— ≤1 certificate per quote; every cert has a
 *                          matched finalized payment of the exact amount
 *   I3 conservationInv   — treasury equals the audited cash-flow ledger
 *   I4 boundedSettlement — every settlement pays out within [0, capDown+capUp]
 *                          and never exceeds pre-settlement treasury
 *   I5 pauseSafety       — pause blocks quoting/activation, NEVER settlement
 *                          (encoded structurally + witness runs)
 */
module lh_ledger {
  // ── Parameters ────────────────────────────────────────────────────
  const U_MAX_NUM: int   // utilization cap numerator   (3)
  const U_MAX_DEN: int   // utilization cap denominator (10) → 30%
  const QUOTE_TTL: int   // quote validity in ticks

  // ── Types ─────────────────────────────────────────────────────────
  type QuoteStatus = Open | Lapsed | Consumed
  type CertStatus = Active | Settled | Expired

  type Quote = {
    id: int,
    premium: int,
    capDown: int,
    capUp: int,          // = collateral required
    issuedAt: int,
    status: QuoteStatus
  }

  type Payment = {
    quoteId: int,
    amount: int,         // what actually arrived on-chain (finalized)
    matched: bool        // consumed by an activation or refund
  }

  type Cert = {
    quoteId: int,
    capDown: int,
    capUp: int,
    expiresAt: int,
    status: CertStatus
  }

  // ── State ─────────────────────────────────────────────────────────
  var time: int
  var paused: bool
  var treasury: int              // on-chain balance of the treasury wallet
  var quotes: int -> Quote       // by quote id
  var payments: List[Payment]    // observed finalized inbound transfers
  var certs: int -> Cert         // by quote id (the 1:1 mapping IS the design)
  var nextQuoteId: int
  // audited cash-flow ledger (event-sourced mirror of treasury):
  var totalIn: int               // ALL finalized inbound transfers (audit: recorded at observation, not at matching — else refunds double-count)
  var totalSettled: int          // settlement amounts paid out
  var totalRefunded: int         // unmatched/failed payments returned
  var initialReserves: int

  // ── Helpers ───────────────────────────────────────────────────────
  def activeCaps(cs: int -> Cert): int =
    cs.keys().fold(0, (acc, k) =>
      if (cs.get(k).status == Active) acc + cs.get(k).capDown else acc)

  def activeCollateral(cs: int -> Cert): int =
    cs.keys().fold(0, (acc, k) =>
      if (cs.get(k).status == Active) acc + cs.get(k).capUp else acc)

  // Worst-case remaining payout: every active cert settles at max
  // (payoff = capDown, fee split 0) and returns its collateral.
  def worstObligations(cs: int -> Cert): int =
    cs.keys().fold(0, (acc, k) =>
      if (cs.get(k).status == Active)
        acc + cs.get(k).capDown + cs.get(k).capUp
      else acc)

  // Unprocessed inbound transfers — money in the wallet that is NOT ours.
  val unmatchedFloat =
    payments.foldl(0, (acc, p) => if (p.matched) acc else acc + p.amount)

  // DESIGN-CRITICAL (found by model checking, 2026-07-07): the headroom
  // guard must measure utilization against reserves NET of unprocessed
  // payments and held collateral. Counting other people's money as
  // reserves lets exposure exceed what the treasury can actually pay.
  val netReserves = treasury - unmatchedFloat - activeCollateral(certs)

  // ── Init ──────────────────────────────────────────────────────────
  action init = all {
    nondet r = 100_000_000.to(2_000_000_000).oneOf()
    all {
      time' = 0,
      paused' = false,
      treasury' = r,
      initialReserves' = r,
      quotes' = Map(),
      payments' = List(),
      certs' = Map(),
      nextQuoteId' = 0,
      totalIn' = 0,
      totalSettled' = 0,
      totalRefunded' = 0
    }
  }

  // ── Actions ───────────────────────────────────────────────────────

  action tick = all {
    time' = time + 1,
    paused' = paused, treasury' = treasury, quotes' = quotes,
    payments' = payments, certs' = certs, nextQuoteId' = nextQuoteId,
    totalIn' = totalIn, totalSettled' = totalSettled,
    totalRefunded' = totalRefunded, initialReserves' = initialReserves
  }

  action setPause(p: bool): bool = all {
    paused' = p,
    time' = time, treasury' = treasury, quotes' = quotes,
    payments' = payments, certs' = certs, nextQuoteId' = nextQuoteId,
    totalIn' = totalIn, totalSettled' = totalSettled,
    totalRefunded' = totalRefunded, initialReserves' = initialReserves
  }

  // Quoting refuses when paused or when the new cert would breach uMax
  // against CURRENT reserves — the same headroom re-check happens again
  // at activation (the race the threat model calls "utilization squeeze").
  action issueQuote = all {
    not(paused),
    nondet premium = 1_500_000.to(20_000_000).oneOf()
    nondet capDown = 1_000_000.to(300_000_000).oneOf()
    nondet capUp = 1.to(capDown).oneOf()  // convexity wedge: capUp < capDown
    all {
      // headroom guard at quote time — against NET reserves (see above)
      (activeCaps(certs) + capDown) * U_MAX_DEN <= netReserves * U_MAX_NUM,
      quotes' = quotes.put(nextQuoteId, {
        id: nextQuoteId, premium: premium, capDown: capDown,
        capUp: capUp, issuedAt: time, status: Open
      }),
      nextQuoteId' = nextQuoteId + 1,
      time' = time, paused' = paused, treasury' = treasury,
      payments' = payments, certs' = certs, totalIn' = totalIn,
      totalSettled' = totalSettled, totalRefunded' = totalRefunded,
      initialReserves' = initialReserves
    }
  }

  // A finalized inbound transfer appears, referencing some quote id.
  // The environment may send the RIGHT amount, a WRONG amount, or
  // reference a stale/unknown quote — all must be handled.
  action observePayment = all {
    quotes.keys().size() > 0,
    nondet qid = quotes.keys().oneOf()
    nondet exact = Set(true, false).oneOf()
    val q = quotes.get(qid)
    val amount = if (exact) q.premium + q.capUp else q.premium // wrong: missing collateral
    all {
      payments' = payments.append({ quoteId: qid, amount: amount, matched: false }),
      treasury' = treasury + amount,     // on-chain balance rises immediately
      totalIn' = totalIn + amount,       // audit ledger records at OBSERVATION
      time' = time, paused' = paused, quotes' = quotes, certs' = certs,
      nextQuoteId' = nextQuoteId,
      totalSettled' = totalSettled, totalRefunded' = totalRefunded,
      initialReserves' = initialReserves
    }
  }

  // Deterministic small quote for witness runs: fits the headroom guard
  // at the minimum initial treasury (100M·3/10 = 30M ≥ 10M).
  action issueSmallQuote = all {
    (activeCaps(certs) + 10_000_000) * U_MAX_DEN <= netReserves * U_MAX_NUM,
    quotes' = quotes.put(nextQuoteId, {
      id: nextQuoteId, premium: 2_000_000, capDown: 10_000_000,
      capUp: 3_000_000, issuedAt: time, status: Open
    }),
    nextQuoteId' = nextQuoteId + 1,
    time' = time, paused' = paused, treasury' = treasury,
    payments' = payments, certs' = certs, totalIn' = totalIn,
    totalSettled' = totalSettled, totalRefunded' = totalRefunded,
    initialReserves' = initialReserves
  }

  // Deterministic exact payment for witness runs (env still uses the
  // nondeterministic observePayment in `step`).
  action payExact(qid: int): bool = all {
    quotes.keys().contains(qid),
    val q = quotes.get(qid)
    all {
      payments' = payments.append({
        quoteId: qid, amount: q.premium + q.capUp, matched: false
      }),
      treasury' = treasury + q.premium + q.capUp,
      totalIn' = totalIn + q.premium + q.capUp,
      time' = time, paused' = paused, quotes' = quotes, certs' = certs,
      nextQuoteId' = nextQuoteId,
      totalSettled' = totalSettled, totalRefunded' = totalRefunded,
      initialReserves' = initialReserves
    }
  }

  // Activation: exactly-once, exact-amount, unexpired quote, headroom
  // re-checked, not paused. Consumes the payment and the quote.
  action activate = all {
    not(paused),
    payments.length() > 0,
    nondet i = 0.to(payments.length() - 1).oneOf()
    val p = payments[i]
    val q = quotes.get(p.quoteId)
    all {
      not(p.matched),
      quotes.keys().contains(p.quoteId),
      q.status == Open,
      time <= q.issuedAt + QUOTE_TTL,
      p.amount == q.premium + q.capUp,               // exact amount only
      not(certs.keys().contains(p.quoteId)),          // exactly-once
      // headroom re-check at activation — against NET reserves (see above)
      (activeCaps(certs) + q.capDown) * U_MAX_DEN <= netReserves * U_MAX_NUM,
      certs' = certs.put(p.quoteId, {
        quoteId: p.quoteId, capDown: q.capDown, capUp: q.capUp,
        expiresAt: time + 7, status: Active
      }),
      quotes' = quotes.put(p.quoteId, { ...q, status: Consumed }),
      payments' = payments.replaceAt(i, { ...p, matched: true }),
      totalIn' = totalIn,   // inflow was already recorded at observation
      time' = time, paused' = paused, treasury' = treasury,
      nextQuoteId' = nextQuoteId, totalSettled' = totalSettled,
      totalRefunded' = totalRefunded, initialReserves' = initialReserves
    }
  }

  // Settlement: NO paused precondition — deliberately (I5). The payoff is
  // an arbitrary environment choice within the caps; the amount paid out is
  // payoff − feeSplit + collateral, floored at 0 (Master Terms §7.2).
  action settle = all {
    certs.keys().size() > 0,
    nondet cid = certs.keys().oneOf()
    val c = certs.get(cid)
    all {
      c.status == Active,
      time >= c.expiresAt,
      nondet payoff = (-c.capUp).to(c.capDown).oneOf()
      nondet feeSplit = 0.to(2_000_000).oneOf()
      val settlementAmount =
        if (payoff - feeSplit + c.capUp < 0) 0 else payoff - feeSplit + c.capUp
      all {
        settlementAmount <= treasury,   // the wallet cannot overdraw
        treasury' = treasury - settlementAmount,
        certs' = certs.put(cid, {
          ...c,
          status: if (payoff == 0) Expired else Settled
        }),
        totalSettled' = totalSettled + settlementAmount,
        time' = time, paused' = paused, quotes' = quotes,
        payments' = payments, nextQuoteId' = nextQuoteId,
        totalIn' = totalIn, totalRefunded' = totalRefunded,
        initialReserves' = initialReserves
      }
    }
  }

  // Refund of a payment that can no longer activate (wrong amount, or its
  // quote lapsed/consumed). Marks it matched so it can't be refunded twice
  // nor later activated.
  action refund = all {
    payments.length() > 0,
    nondet i = 0.to(payments.length() - 1).oneOf()
    val p = payments[i]
    val q = quotes.get(p.quoteId)
    all {
      not(p.matched),
      or {
        p.amount != q.premium + q.capUp,
        q.status != Open,
        time > q.issuedAt + QUOTE_TTL
      },
      p.amount <= treasury,
      treasury' = treasury - p.amount,
      payments' = payments.replaceAt(i, { ...p, matched: true }),
      totalRefunded' = totalRefunded + p.amount,
      time' = time, paused' = paused, quotes' = quotes, certs' = certs,
      nextQuoteId' = nextQuoteId, totalIn' = totalIn,
      totalSettled' = totalSettled, initialReserves' = initialReserves
    }
  }

  action lapseQuote = all {
    quotes.keys().size() > 0,
    nondet qid = quotes.keys().oneOf()
    val q = quotes.get(qid)
    all {
      q.status == Open,
      time > q.issuedAt + QUOTE_TTL,
      quotes' = quotes.put(qid, { ...q, status: Lapsed }),
      time' = time, paused' = paused, treasury' = treasury,
      payments' = payments, certs' = certs, nextQuoteId' = nextQuoteId,
      totalIn' = totalIn, totalSettled' = totalSettled,
      totalRefunded' = totalRefunded, initialReserves' = initialReserves
    }
  }

  action step = any {
    tick,
    issueQuote,
    observePayment,
    activate,
    settle,
    refund,
    lapseQuote,
    setPause(true),
    setPause(false)
  }

  // ── Invariants ────────────────────────────────────────────────────

  // I1 — solvency, the two facts the product actually promises:
  //  (a) customer money (float + collateral) is always in the wallet;
  //  (b) the treasury covers the WORST-CASE payout of every active
  //      certificate simultaneously, plus all refundable float.
  val solvencyInv =
    treasury >= unmatchedFloat + activeCollateral(certs)
    and treasury >= unmatchedFloat + worstObligations(certs)

  // I2 — exactly-once activation with exact-amount matched payment.
  val noDoubleActivation =
    certs.keys().forall(cid =>
      quotes.keys().contains(cid)
      and quotes.get(cid).status == Consumed
      and payments.indices().exists(i =>
        payments[i].quoteId == cid and payments[i].matched
        and payments[i].amount == quotes.get(cid).premium + quotes.get(cid).capUp))

  // I3 — conservation: the treasury equals the audited ledger. Unmatched
  // payments are float (arrived but not yet activated/refunded);
  // `unmatchedFloat` is defined with the helpers above.
  val conservationInv =
    treasury == initialReserves + totalIn - totalSettled - totalRefunded

  // I4 — every settlement bounded (checked per-action by construction:
  // settlementAmount ∈ [0, capDown + capUp] and ≤ treasury); globally:
  val boundedSettlement =
    totalSettled >= 0 and treasury >= 0

  // I5 — pause safety is structural: `settle` has no `paused` guard.
  // Witness: the run below settles while paused.
  val allInvariants =
    solvencyInv and noDoubleActivation and conservationInv and boundedSettlement

}

// Concrete instance: 30% utilization cap, 2-tick quote TTL.
module lh_ledger_tests {
  import lh_ledger(U_MAX_NUM = 3, U_MAX_DEN = 10, QUOTE_TTL = 2).*

  // I5 witness: settlement proceeds WHILE PAUSED.
  run settleWhilePausedTest =
    init
      .then(issueSmallQuote)
      .then(payExact(0).expect(payments.length() == 1))
      .then(activate)
      .then(setPause(true))
      .then(8.reps(_ => tick))
      .then(settle)
      .expect(certs.get(0).status != Active and paused)

  // I2 witness: a second activation of the same quote must be impossible.
  run doubleActivationImpossibleTest =
    init
      .then(issueSmallQuote)
      .then(payExact(0))
      .then(activate)
      .then(activate)                 // second activation of same quote
      .fail()                         // must be impossible
}
