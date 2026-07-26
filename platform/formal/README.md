# Formal model — LH certificate/payment/settlement ledger

`lh_ledger.qnt` is a [Quint](https://quint-lang.org) specification of the platform's
money-critical state machine (plan §6.3, gate G2). The payoff function is abstracted:
at settlement the environment picks **any** payoff in `[−Cap_up, +Cap_down]`, so the
checked properties hold for every admissible market outcome, not just simulated ones.

## Run

```bash
cd platform
pnpm dlx @informalsystems/quint test formal/lh_ledger.qnt --main lh_ledger_tests
pnpm dlx @informalsystems/quint run  formal/lh_ledger.qnt --main lh_ledger_tests \
    --invariant allInvariants --max-samples 10000 --max-steps 60
# Exhaustive/symbolic checking (Apalache, needs Java):
# pnpm dlx @informalsystems/quint verify formal/lh_ledger.qnt --main lh_ledger_tests \
#     --invariant allInvariants
```

Status 2026-07-07: witness runs pass (10,000 executions each); all invariants hold over
10,000 random traces × 60 steps. Apalache symbolic verification is the remaining G2 step
(run before the hedging pilot goes live).

## Invariants

| ID | Property |
|---|---|
| I1 `solvencyInv` | treasury always covers unprocessed payments + held collateral, AND the worst-case simultaneous payout of every active certificate |
| I2 `noDoubleActivation` | ≤ 1 certificate per quote; every certificate has a matched, exact-amount, finalized payment |
| I3 `conservationInv` | treasury == initial + all observed inflows − settlements − refunds (the audit ledger mirrors the wallet exactly) |
| I4 `boundedSettlement` | settlement amounts ∈ [0, Cap_down + Cap_up], wallet never overdrawn |
| I5 pause safety | `settle` has no `paused` guard (structural) + `settleWhilePausedTest` witness — pausing sales can never strand owed funds |

## Design rules DISCOVERED by model checking (bind the implementation)

1. **Net-reserves headroom rule.** The utilization guard at quote AND activation must
   measure exposure against `treasury − unmatchedFloat − activeCollateral`, never the
   raw wallet balance. Counting unprocessed payments or held collateral as reserves lets
   aggregate exposure exceed what the treasury can actually pay (counterexample found at
   ~400 traces/s before the fix). ⇒ Implementation requirement for the pool/quoting
   service; the prototype's `availableHeadroom(pool)` uses pool-ledger reserves, which
   is correct ONLY if payment float and collateral are ledgered outside `reservesUsdc`.
2. **Observation-time inflow ledger.** The audit ledger must record inbound transfers
   when they are OBSERVED (finalized), not when they are matched/activated — otherwise
   refunds of unmatched payments double-count and treasury reconciliation (I3) breaks.
   ⇒ Requirement for the event store's reconciliation sweep (FR-A5).

## Correspondence to the implementation

| Model | Implementation |
|---|---|
| `issueQuote` guard | quote service headroom check (`@lh/core` availableHeadroom + net-reserves rule above) |
| `observePayment` | payment watcher (finalized commitment, reference key) |
| `activate` | exactly-once activation keyed on quoteId (AR-8, SR-3) |
| `settle` | settler worker; `settlementAmount = max(0, payoff − feeSplit + collateral)` = Master Terms §7.2 |
| `refund` | refund queue for wrong-amount/lapsed payments (Master Terms §4.4) |
| `setPause` | kill switch (FR-A4) — never gates `settle` |

Phase-4 CI hook (planned): replay production event-log traces against this model
(trace conformance) so spec and implementation cannot drift silently.
