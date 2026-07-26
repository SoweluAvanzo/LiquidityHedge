# LH Platform — Operational Runbooks (Phase 5, v0.1)

Owner: Blocksventures ops (currently: founder). Review at every gate. Every runbook ends
in either "resolved + post-mortem note" or escalation to the kill switch (RB-0).

## RB-0 — Kill switch (pause new business, never settlements)

**Trigger:** any invariant monitor failure, suspected key compromise, oracle divergence
beyond policy, legal demand, or operator judgment.
**Action:** `ledger.setPaused(true)` via the ops endpoint (or directly against the
ledger service). Verify: `GET /api/hedge/status` shows `paused: true`; quoting and
activation refuse; `dueForSettlement()` continues to be processed. **Settlement and
refunds NEVER pause** (Master Terms §7.4/§10; formal model I5).
**Exit:** root cause identified and fixed; invariants green; unpause with a logged
reason.

## RB-1 — Invariant monitor alert (I1–I4)

**Meaning:** the runtime state diverged from the verified design — this should be
impossible; treat as severity-1.
**Steps:** 1) RB-0 pause. 2) Snapshot `hedge-events.jsonl` + DB/state. 3) Replay events
via `CertificateLedger.fromEvents` offline: if replay ALSO fails, the log is corrupt
or a bug wrote an invalid transition — diff the last events against treasury on-chain
history. 4) Reconcile the real wallet balance vs I3's expectation; any gap is either a
missed inbound payment (run a watcher rescan from the last cursor) or an unauthorized
outflow (→ RB-3 key compromise). 5) Do not resume until replay is clean and the wallet
reconciles to the µUSDC.

## RB-2 — Settlement stall (certificate past expiry > 1 h unsettled)

**Steps:** 1) Check settler worker liveness + RPC health. 2) Check the settlement price
policy inputs: pool account readable? cross-check source up? divergence > threshold →
the deferral window of Master Terms §7.1 applies (max 6 h) — document the readings.
3) If the hot wallet lacks float: top up from the Squads vault (threshold approval),
then re-run the settler. 4) Settlement executed late: include the §8 disruption note in
the buyer's settlement statement. Buyers must always receive what they are owed — this
runbook has no "give up" branch.

## RB-3 — Suspected key compromise (hot wallet or server)

**Steps:** 1) RB-0 pause. 2) Move remaining hot-wallet float to the Squads vault
immediately. 3) Rotate server secrets (RPC keys, session secrets); redeploy from clean
CI artifacts. 4) Audit outflows against the settlement/refund ledger — any transfer
without a matching ledger event is theft: document, notify affected users per T&C,
file incident report. 5) New hot wallet keypair; resume with reduced float cap.
The Squads vault (2-of-3) is unaffected by a single key loss by design.

## RB-4 — Data-feed degradation (Birdeye/Binance down or stale)

**Expected behavior (verify, don't fight it):** regime updates REFUSE on incomplete
coverage (§E7) → quotes start failing with "regime snapshot stale" after 900 s. This is
correct: no quoting on bad data. Settlements continue (they use the settlement price
policy, not the regime). **Steps:** confirm the guarded-vol error in the job logs, check
vendor status, wait or switch to the fallback candle source, then run
`pnpm --filter @lh/ops-jobs regime-once` and verify `coverageRatio ≥ 0.98`.

## RB-5 — Refund queue handling (Master Terms §4.4)

Wrong-amount/late/unreferenced payments: the ledger lists refundable payments
(unmatched + ineligible). SLA: return within 5 business days, minus network fees; dust
under $1 is not returned. Execute via `buildPayoutInstructions` with memo
`refund:<txSignature>`; verify the PaymentRefunded event and I3 reconciliation after.
Never refund to an address other than the sender (`payment.senderWallet`).

## RB-6 — Backup & restore drill (quarterly)

1) Restore last night's backup of the event log + DB to a scratch environment.
2) `CertificateLedger.fromEvents` must load with invariants green.
3) Compare replayed treasury vs the live wallet balance at the backup timestamp.
4) Record drill result + duration in the ops log. A failed drill is a launch blocker
for the next gate.

## RB-7 — Devnet rehearsal (pre-G3, repeatable)

`pnpm --filter @lh/ops-jobs devnet-rehearsal` — full money-path e2e (pay with memo →
scan → activate → expire → settle → on-chain payout). Needs ~1 devnet SOL on the
rehearsal treasury (keypairs persist in `lh-protocol-archive/devnet-rehearsal/`; fund
via https://faucet.solana.com). Must pass before any mainnet dry run; re-run after any
change to adapters, ledger, or settlement math.
