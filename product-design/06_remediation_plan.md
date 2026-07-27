# Remediation plan — open findings after the 2026-07-27 audits

Sources: the security/correctness audit (17 findings, all confirmed), the
mock-data hunt (A/B/C), and two independent paper-verification agents
(D/F) plus the calculation-and-storage audit. Everything listed here is
**confirmed open**; items already fixed are not repeated.

The ordering below is deliberate. It is **not** severity order — it is
dependency order, because several fixes obviate or move others, and one
of them changes every number on the dashboard.

---

## Decisions needed before Phase 1 (blocking, small)

These are product calls, not engineering ones. Each changes what the code
should do, so answering them first avoids building the wrong thing.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Premium floor: the platform overrides to **$0.05**, the protocol constant is **$1.50** (30× apart, `viability.ts` vs `types.ts`) | pick one, or make the override explicit per environment | **$0.05 as the live value, delete the $1.50 constant** or rename it `LEGACY_`. Two live constants for one governance parameter is the actual defect. |
| **D2** | Out-of-range positions: what should the viability row show? | (a) numbers as today, (b) an explicit "out of range" state with no index, (c) index plus a prominent qualifier | **(b)**. `c` is measured at a tick the position does not span, FV is structurally ≤ 0, and the hedge is a pure cost. The numbers are not comparable to in-range ones. |
| **D3** | Data product: keep or drop the **email-delivery** and **"row count quoted before you pay"** claims | implement, or remove the copy | **Implement the row-count quote** (it is one `SELECT`), **drop the email-delivery claim** (no per-buyer mail exists and building it is not on the critical path). |
| **D4** | Hedge fee split | keep pinned at 0, or wire the real fee reader | **Keep at 0** until Phase 4. The boot assertion already welds it; do not unpin for a demo. |

---

## Phase 0 — Landmines (½ day, do first, independent of everything else)

Small, severe, and each one silently disables a control that is believed
to be working.

### 0.1 · `${VAR:-}` sets eleven config values to the empty string — **regression introduced 2026-07-27**
`deploy/docker-compose.yml:174-184`. `Number("") === 0` and `""` is not
nullish, so `process.env.X ?? default` does **not** catch it. Consequences
with an otherwise-valid `.env`:

- `SETTLEMENT_INTERVAL_SECONDS` → 0 → `if (seconds <= 0) return;` →
  **the settlement watcher never starts**, silently undoing the fix for
  audit finding #1 (the critical one).
- `HEDGE_TENOR_SECONDS` → 0 → **FV = $0.00** presented as formula output;
  certificates expire at activation.
- `MAX_OPEN_QUOTES_PER_OWNER`, `MAX_LIFETIME_QUOTES` → 0 → the A2/A3
  griefing guards disable themselves (`maxLifetimeQuotes > 0 && …`).
- `ORDER_TTL_SECONDS`, `DOWNLOAD_TTL_SECONDS` → 0 → orders and grants
  expire instantly. `MIN_REFUND_USDC` → 0 → dust floor gone.
- `USDC_MINT` → `""` → `new PublicKey("")` throws every cycle.

**Fix:** carry the real defaults in compose (`${VAR:-604800}`) **and**
add a `numericEnv(name, default)` helper that treats `""` as unset. Belt
and braces, because this is the *second* time an empty string has slipped
past `??` in this codebase (the earlier one was `NEXT_PUBLIC_RPC_URL`).
**Verify:** boot with an empty `.env` and assert the settler logs its
start line and the tenor is 604800.

### 0.2 · Operator action list is inert — **regression introduced 2026-07-27**
`services/ops-jobs/src/data-report.ts:429-440`. The reader matches
`"Fulfilled"` / `"Expired"` / `"Refunded"`; the ledger emits
`"OrderFulfilled"` / `"OrderExpired"` and never `"Refunded"`. It also
reads `e.orderId` / `e.amountUsdc` from `OrderCreated`, which carries
them nested under `e.order`. Net effect: every entry shows
`0.000000 USDC`, and **fulfilled orders never clear**, so a 200 USDC
pre-order and a $1.03 refund are indistinguishable and permanent.
**Fix:** read `e.order.*` for `OrderCreated`, match the real event names.
**Verify:** unit test replaying a synthetic ledger through the reader.

### 0.3 · Download token is replayable for 24 h
`packages/commerce/src/order-ledger.ts` — `checkDownloadToken` is a pure
predicate; neither it nor `api/data/download` consumes the token. The UI
says *"The link works once and expires"*.
**Fix:** consume on first successful stream (mark `downloadToken`
redeemed, keep re-issue available against the claim secret from #9).
**Verify:** regression test — second GET with the same token is 403.

---

## Phase 1 — Estimator quality programme (the core of this plan)

The goal is not "no longer wrong". It is **the best estimate the available
data supports, with its uncertainty stated**. Ordered by how much
estimator quality each step buys.

**Build the regression harness first.** Every step here moves every number
on every card. Capture `/api/portfolio` for the 4 real positions into a
golden file and diff after each change, so movements are deliberate.

### 1.1 · Replace modelled fee yield with DIRECT measurement — the largest single quality gain

Today: `r_pool = volume₂₄ₕ × feeTier × (1 − φ_protocol) / TVL`, using a
**vendor's** 24h volume and TVL. That is a model of fee accrual built on
two third-party aggregates.

We no longer need it. The collector has been recording
`feeGrowthGlobalA/B` every 15 minutes for 107 pools — **that counter is
what the Whirlpool program itself uses to decide what a position is
owed**. Realised pool yield per unit of liquidity over any window is

```
r_pool = Σ Δ feeGrowthGlobal × L_active / 2⁶⁴ / (TVL · Δt)
```

exact, vendor-free, and already verified: the calculation audit
reproduced `computeRangeFeeYield` to the unit against live data, and a
15.7 h window on SOL/USDC gave **$13 980 measured** vs **$13 855**
modelled-with-protocol-fee vs **$15 925** modelled-gross.

**Do:** switch `measuredDailyYield` to the snapshot-derived figure, with
the Birdeye path retained only as a labelled fallback when snapshot
coverage for that pool is too short. Report the window actually used.
**Why it matters:** removes vendor error, removes the protocol-fee
correction as a *modelling* step (it is already inside the accumulator),
and makes the number reproducible from data we sell.

### 1.2 · Position-level realised yield, replacing `r_pool × f × c`

The current chain multiplies three estimates: pool yield × in-range
fraction × concentration factor. Each carries error; `c` is measured at
spot and is meaningless when the range excludes spot (F10), and `f` is a
model.

We can now measure the position directly. `feeGrowthInside` (built for
the fees-owed fix) evaluated at two snapshot times gives

```
fees_position(t₀ → t₁) = L_pos × Δ feeGrowthInside / 2⁶⁴
```

which is **exactly** what the position earned — in range or not,
concentration and occupancy already inside it. No `f`, no `c`, no vendor.

**Do:** compute realised position yield over a trailing window from
persisted tick-account reads; fall back to the modelled chain only when
history is insufficient, and label which was used.
**Cost:** requires persisting per-position `feeGrowthInside` or the tick
accounts. This is the one item here that needs new storage, and it is
worth it: it collapses a three-estimate product into one measurement.

### 1.3 · Deterministic quadrature for FV and E[ΔV] — closes D-1, F2, F6

20 000 MC paths at a fixed seed give FV a 0.9% SE (adequate) and
`E[ΔV]` an **8–108%** SE, because `E[ΔV]` is unclamped and its variance is
dominated by a linear term whose expectation is exactly zero. VI₂ for
`38uAbr` spans **3.90–12.66 on the seed alone**.

`computeQuadratureFV` (Simpson N=200, the paper's §3.2 method) already
exists and is what the hedge quote path uses. Two integrals, ~400
evaluations, deterministic, ~100× more accurate and cheaper.
**Do:** use it for both estimands. Verify VI₂ is seed-invariant.
**If MC is ever needed again:** control variate `β·(S_T − S₀)` with
`β = V'(S₀)` — measured 6–18× variance reduction — plus antithetics.

### 1.4 · A better volatility estimator, with its uncertainty

Three separate problems with σ today:

1. **Unguarded** — `computeRealizedVolGuarded` is documented as "the only
   entry point the regime updater is allowed to use"; the viability path
   calls the raw one and discards `coverage`.
2. **Contaminated** — the trailing candle is the in-progress day,
   annualised as a full day (~0.8% bias at mid-day).
3. **Inefficient and unqualified** — close-to-close RV on 30 daily
   returns has a relative standard error of `1/√(2n) ≈ 12.9%`, and is
   reported as a bare number ("sigma 62.0%").

**Do, in order:**
- Use the guarded entry point; drop the partial candle.
- Switch to an **OHLC-based estimator** — Garman–Klass, or Rogers–Satchell
  if drift robustness is wanted. Both use the high/low/open we *already
  fetch and discard*, and are ~5–7× more efficient than close-to-close at
  the same sample size: the same 30 days then buys the precision of
  ~150–200 days of closes. This is free precision from data on hand.
- Report σ's own interval (χ² for the variance, or a block bootstrap) and
  propagate it (§1.7).
- Consider an EWMA or a longer window with decay so σ is not a step
  function of a 30-day cliff.

### 1.5 · Honest uncertainty on the empirical in-range fraction

The estimator reports `p05`/`p95` across **358 rolling 7-day windows** on
daily closes. Those windows **overlap by 6 of 7 days**, so they are far
from independent and the band is too narrow. Effective sample size is
closer to `358 / 7 ≈ 51`.

**Do:** either use non-overlapping windows (honest, fewer), or keep
overlapping windows and compute the interval by a **moving-block
bootstrap** with block length ≥ the horizon — which is exactly the
technique already implemented for fee intensity in `risk-models`. State
the effective sample size next to the interval rather than the raw window
count, which currently overstates the evidence.

### 1.6 · Be explicit about the measure — the central methodological choice

`E[ΔV]` is computed under the **risk-neutral** martingale (μ = −σ²/2), so
it is purely the Jensen/concavity term — genuine divergence loss, and
measure-consistent with the FV computed from the same draws. The paper's
`ΔV_w` (§2.4.1, §8.5) is a **realised, physical-measure** quantity from a
52-week backtest. These are different estimators and should not be
compared directly.

Sensitivity is not small — measured on `38uAbr`, sweeping annualised
drift with everything else fixed:

| drift | E[ΔV] | r_u |
|---|---|---|
| −50%/yr | −$0.01528 | +14.13 bps/day |
| **0 (current)** | −$0.00083 | **+0.76 bps/day** |
| +20%/yr | +$0.00496 | −4.59 bps/day → VI = ∞, green |
| +50%/yr | +$0.01364 | −12.61 bps/day |

**Do:** keep risk-neutral as the point estimate — it is the only
assumption-free choice and the index claims to measure concavity, not a
directional view — but (a) say so on the card ("risk-neutral expected
divergence loss", not the paper's backtest figure), and (b) show a
drift-sensitivity band so a reader sees the result is drift-determined.

### 1.7 · Propagate uncertainty, and stop printing digits the estimator cannot resolve

Every input is an estimate; the output is displayed as a bare number to
two decimals. After 1.3 the MC noise is gone, but σ error (~13%, or ~5%
after 1.4), yield-window error and in-range error remain.

**Do:** propagate to an interval on both indices — analytically where the
map is smooth (σ dominates; a one-dimensional delta method suffices) or
by resampling. Then **display at the resolved precision**: a band, or one
significant figure, with badge hysteresis so a 0.17% price move cannot
flip a verdict (measured: `mGADEK` crossed the VI = 1 boundary on a
12-minute price move).

This is the same discipline already applied to the correlation matrix,
which ships a CI and a p-value. The viability indices should not be held
to a lower standard than the correlation panel.

### 1.8 · One source for premium parameters — closes A7, D-5, part of C6

The dashboard hardcodes `EFFECTIVE_MARKUP = 1.08` and
`FEE_SPLIT_RATE = 0.1`; the real quote path uses `max(1.05, ivRvRatio)`
from **live** Binance IV and `feeSplitRate = 0`. So the dashboard prices a
certificate nobody would be quoted, and `y = 0.1` inflates the
floor-branch breakeven by 11.1% on every card.
**Do:** a read-only `getPricingParams()` consumed by both paths. Settles
decision D1 as a side effect.

### 1.9 · Out-of-range semantics — closes F8, F10 (per decision D2)

Below range, FV is structurally ≤ 0 and `c` is measured at a tick the
position does not span. After 1.2 the realised-yield path makes `c`
unnecessary; until then, report an explicit out-of-range state and put
`concentrationFactorSource: "measured" | "unavailable"` on the wire so a
substituted value can never look measured.

### 1.10 · Verify the divergence flag is like-for-like, and fix the prediction log

Both estimators now integrate real bounds, which should remove the
width-mismatch contamination (A8/F7) — **confirm it**. Fix the prediction
log, which pairs a `widthBps` from one estimator with a `gbmFraction`
from the other (F12), making it useless for the estimator arbitration it
exists for. That log is the only mechanism for *empirically scoring* the
estimators over time, which is the long-run route to knowing which is
better — worth repairing properly.

## Phase 2 — Make the claims true (1 day)

Every item is a live promise the code does not keep. Cheapest correct
action per decision D3.

| Item | Fix |
|---|---|
| **B1** "covered period and exact row count quoted before you pay" — implemented nowhere, and the checkout says the *opposite* | one `SELECT min(t), max(t), count(*)` on `lh.pool_snapshots` at order time; put it on the order response and the page |
| **B3** "delivery by email attachment" — no per-buyer mail exists | remove the claim (D3) |
| **B4** dataset advertised `InStock` in JSON-LD while `/api/data/order` returns 503 | gate `availability` on whether sales are actually configured |
| **B5** "Memo (include it verbatim)" — no memo parsing in the data path | already softened; finish by stating the memo aids reconciliation only |
| **B7** paid buyer can get 503 with the order already `fulfilled` | do not advance order state until the stream is known to be producible |
| **B8** "roughly 107 pools" hardcoded | derive from `count(*) FROM lh.tracked_pools` |
| **C1** "anchored at activation" — `buildAnchorMemoIx`/`merkleRoot` have zero production callers | remove the claim now; implement in Phase 4 |
| **C6** "every input shown on the quote" — tenor, `ivRvRatio`, `markupFloor`, `y`, `expectedDailyFee` are never shown | show them, or narrow the claim |
| **C9** "checking the chain every 5 seconds" — the poll reads the local ledger | correct the copy |
| **C10** "No signature is ever requested" vs the hedge panel requiring `signMessage` | qualify as "no *transaction* signature" |

---

## Phase 3 — Dataset delivery quality (1 day)

| Item | Fix |
|---|---|
| **#3** the emailed export globs JSONL frozen at **642 rows** while Postgres holds **6 955** | give `buildDataReport` a Postgres source |
| **#4** `pair` ships mint prefixes for **61 of 107** pools against a spec promising "SOL/USDC" | resolve symbols from Metaplex/token list, or state the degradation in the spec |
| **#5** `quoteIsUsd` is `t`/`f` from Postgres, `true`/`false` from the fallback | normalise both to `true`/`false` |
| **#7** dropped snapshot rows report success | compare `appendMany`'s `rowCount` against `captured.length`, warn on shortfall |

---

## Phase 4 — Pre-enablement gates for the hedge product

**Do not set `HEDGE_TREASURY_ADDRESS` until every item here is closed.**
All are latent today (the endpoints 503), but each one is an audit record
or a control that would be false the moment money moves.

- **C2** — settlement writes `crossCheck = price, divergenceBps = 0` on
  any Birdeye failure: an audit record asserting an independent source
  was consulted and agreed *exactly*. The §7.1 divergence guard disables
  itself precisely when it is needed. **Refuse to settle instead.**
- **C3** — implemented settlement ≠ the published policy the term-sheet
  hash commits to. The hash says "price at the first finalized slot at or
  after expiry, TWAP-median deferral on >1% divergence"; the code reads
  the pool's *current* `sqrtPrice` whenever the cycle happens to run, and
  takes `getSlot` in a *separate, later* call. Either implement the
  policy or re-hash a policy that matches the code.
- **C4** — "published reserves … verifiable on-chain" is seeded from an
  operator-typed env value and moved only by ledger events; nothing reads
  the treasury ATA. Invariants check the ledger against its own
  arithmetic, so a funding shortfall cannot trip the green badge.
  **Read the ATA; reconcile; fail loudly on mismatch.**
- **C5** — the IV fallback (`ivRvRatio = 1.0` when Binance is down) is
  pixel-identical to a measurement on the quote. Surface `ivSource`.
- **C8** — dev endpoints write `txSignature: dev-<uuid>` as a
  `PaymentObserved` *fact* that credits `treasuryUsdc`, replayed at every
  boot, permanently inflating the C4 figure. Mark synthetic events and
  refuse to replay them outside dev mode.
- **D4** — wire a real `readAccruedFees` before unpinning the fee split.

Plus the pre-existing owner-side gates: BVI counsel sign-off, Squads
treasury creation, mainnet cent-scale dry run.

---

## Phase 5 — Cleanup

- **F13** — raw internal exception strings (`"widthBps 0 out of (0, 10000)"`)
  are surfaced verbatim to the browser as `fallbackReason`; and
  `w >= 1` returns exactly 1.0 where the true probability is `Φ(z) < 1`.
- **#6** — `pExitRange` counts step 0, so an already-out-of-range position
  reports 100% by construction, carrying no information.
- **#8** — `tickToSqrtPriceX64` is documented as a floor but uses
  `Math.pow` (rel. err 1.4e-13). Immaterial; document or make exact.
- **Dead code** — `packages/core/src/market-data/birdeye-adapter.ts`
  returns a hardcoded `sigmaPpm = 200_000` (20% annualised) when candles
  are insufficient. **No caller anywhere.** Delete before someone wires
  it up.
- **D-8** (documentation) — the paper's own §2.4.5 uses `P̄ ≈ $129/wk`
  while §8.5.3 uses `$76/wk` for the same backtest; §2.4.5 appears not to
  have been refreshed after the capped-put → signed-swap migration.
- **F5** — `lh-protocol/scripts/sensitivity-analysis.ts:126-131` excludes
  the premium floor and justifies it by claiming the floor *shrinks* the
  wedge. The wedge is `φP/(7V)`, strictly **increasing** in `P`. Correct
  the comment and re-run §8.8 with a `V` axis; restate the claim as
  "< 0.65 bps/day at the §8.8 reference position", not a universal bound.

---

## Verification strategy

Per phase, not at the end:

1. **Golden-file diff** of `/api/portfolio` for the 4 real positions —
   every changed number explained before merge.
2. **Re-run the two paper-verifier agents** after Phase 1. They found the
   in-range and protocol-fee defects independently; they are the right
   check on the estimator change.
3. **`pnpm -r test`** must stay green, and each fix lands with a test that
   would have caught it. Note that the broken `Φ` survived for months
   because its callers' tests asserted only monotonicity and `[0,1]`
   bounds — assert *known values*, not shapes.
4. **Live re-check against the chain** for anything touching fees or
   yield: the protocol-fee defect was settled by comparing modelled fees
   against `Σ Δ feeGrowthGlobal × L / 2⁶⁴` over a real window.
5. **CI gates** (already green) re-run before each phase closes.

## What this plan deliberately does not do

- No new features. Every item is an existing claim or an existing number.
- No refactor of the hedge ledger, the payment path, or the collector —
  all three were audited clean and are load-bearing.
- No attempt at ISO 27001 evidence. That is an ISMS programme, not a code
  change, and is tracked separately.

---

## STATUS — updated 2026-07-27, end of session

### Decisions taken (owner)

| # | Decision | Outcome |
|---|---|---|
| D1 | Premium floor | **Keep the lowest: $0.05.** The $1.50 protocol constant is to be removed or renamed `LEGACY_`. *(not yet done)* |
| D2 | Out-of-range display | **Explicit out-of-range state**, not numbers that look comparable to in-range ones. *(not yet done — Phase 1.9)* |
| D3 | Data product claims | **Implement the row-count quote; drop the email-delivery claim.** *(not yet done — Phase 2)* |
| D4 | Hedge fee split | **REVERSED by the owner: wire a real fee reader, restore y = 0.1.** ✅ **DONE** |

### Phase 0 — COMPLETE ✅

- **0.1** `numericEnv()` in `@lh/storage` replaces all 24 `Number(process.env.X ?? d)`
  sites. `""` now means unset; non-numeric junk throws rather than becoming NaN.
  This was a regression introduced the same day: `SETTLEMENT_INTERVAL_SECONDS=""`
  had silently disabled the settlement watcher.
- **0.2** Operator action list repaired (`data-report.ts`): matched `"Fulfilled"`
  where the ledger emits `"OrderFulfilled"`, and read order fields from the wrong
  nesting level. 6 regression tests. **Open sub-item:** the ledger has no
  "refund paid" event, so a refund-due order cannot be marked resolved.
- **0.3** Download grants are single-use: `redeemDownloadToken()` verifies AND
  consumes atomically, before the stream (closes the concurrent-request race).
  Safe only because the claim secret can re-issue — the two fixes are coupled.
  4 regression tests.

### D4 — COMPLETE ✅ (owner reversed the original recommendation)

`apps/web/src/lib/server/fee-reader.ts` is a real reader:
- `FeeCheckpoint` (fee-growth-inside, liquidity, decimals) is snapshotted by the
  runner **at activation** via the new `readFeeCheckpoint` port — the accumulator
  cannot be recovered afterwards.
- Write-once, committed as a `FeeCheckpointRecorded` event, replay-safe.
- At settlement: `L × Δ feeGrowthInside / 2⁶⁴`, token A valued at the **same**
  settlement price the payoff uses.
- Returns **0** on every failure path (no checkpoint, unreadable position, no
  price, liquidity changed mid-certificate, implausible magnitude) — never an
  estimate.
- `feeSplitRate` restored to **0.1**; the boot assertion that refused a non-zero
  split is gone with the stub it guarded.

**396 tests passing**, build clean, deployed to :8080.

### Phase 1 progress — updated 2026-07-27 (afternoon session)

**Regression harness — DONE ✅.** `platform/tools/regression/regress.mjs`
(capture / diff / accept) + `REGRESSION_LOG.md`; golden of `/api/portfolio`
for the 4 real positions. Every deploy below has its number movements
explained in the log before re-baselining.

**1.1 — DONE ✅, deployed.** `poolDailyYield` is measured from our own
15-min `feeGrowthGlobal` snapshots (`measurePoolDailyYield` in
`@lh/market-data`; web reader `apps/web/src/lib/server/pool-yield.ts`).
Birdeye retained only as a labelled fallback (`poolYield.source` /
`fallbackReason` / window on the wire, shown on the card). The
concentration factor's TVL now comes from exact on-chain vaults.
Measured vendor error at deploy: **+5.73%** (Birdeye understated), 20h
window, 81 gapless intervals. The simulate route's stochastic fee
intensity anchors its LEVEL to the same basis; only the fluctuation
shape still uses Birdeye pair candles.

**1.2 — DONE ✅, deployed; realised path activates as history accrues.**
New `lh.position_fee_snapshots` + `lh.tracked_positions`; positions are
auto-registered by the dashboard, snapshotted by the collector each
cycle AND opportunistically on every portfolio request (discovery
already reconstructs `feeGrowthInside` — persisting it is free). Once
≥ 6h of coverage exists, `measuredDailyYield` = the position's own
`L × Δinside / 2⁶⁴` (source `"realised-inside"` on the wire); until
then the modelled r_pool × f × c chain serves, labelled
`"modelled-chain"` with the reason. Thresholds via
`POSITION_YIELD_*` / `POOL_YIELD_*` env (defaults in code, `numericEnv`).

Commit: `ed30198`. Live verification passed: served poolDailyYield
reproducible bit-for-bit from `lh.pool_snapshots`; stored
feeGrowthInside matches independent chain reads bit-for-bit; web and
collector writers agree.

**Post-deploy estimator audit (two independent agents, 2026-07-27) —
confirmed findings fixed same day:**

- **Staleness**: no max-age gate existed on either measured window — a
  dead collector would have served days-old data labelled "measured".
  Now gated at `*_MAX_AGE_SECONDS` (default 1h) with the window's
  `lastT` on the wire.
- **Estimand** (both agents' top finding): the realised path originally
  substituted a TRAILING yield into E[F]/VI — forward quantities. Now
  serves realised IN-RANGE intensity × forward in-range fraction;
  trailing occupancy never enters a forward formula.
- **Torn reads**: feeGrowthInside mixes pool and tick accounts read in
  separate RPC calls; a boundary crossing in between corrupts the
  snapshot. Both the collector and discovery now re-read the pool and
  drop the capture unless the accumulator was stable across reads.
- **Current-L suffix**: realised fees are measured only over history at
  the position's current liquidity (the dust-withdrawal case otherwise
  produced a green badge from another position's fees).
- Relative per-interval plausibility ceiling (0.5 × position value);
  simulate constant-mode rates now labelled "modelled" on fallback;
  registration capped/SOL-USDC-only/append-throttled; finite guards on
  all wire numerics; prov key says "est. (model)" until realised.

**Deferred, scheduled:** out-of-range explicit state → 1.9 (interim
risk reduced by the estimand fix); VI₂ MC sign-noise → 1.3 quadrature;
`null=∞` wire encoding rework → 1.7; tracked-positions retention job →
Phase 5 cleanup (no DELETE grant exists — needs a maintenance role);
`hedge-ledger`'s governance `expectedDailyFee` vs the card's E[F] →
1.8 `getPricingParams()`.

**1.3 — DONE ✅, deployed.** The viability card's FV and E[ΔV] now come
from the paper's §3.2 Simpson quadrature via `quadratureExpectation`
(extracted from `computeQuadratureFV`, which now delegates to it — the
differential parity suite confirms bit-identical results, so the hedge
quote path is untouched). The 20k-path seeded MC is gone from the card.
Measured effect at deploy: E[ΔV] corrected −2.2% to **−29%** (38uAbr,
the position whose VI₂ spanned 3.90–12.66 on seed — the MC had
flattered it; VI₂ 0.92 → 0.81). Two captures 31s apart move every
twoSided field ≤ 0.01% — seed-invariance verified by absence of a
seed. E[ΔV] is now labelled risk-neutral on the card (part of 1.6's
ask). Closes D-1, F2, F6.

Next: **1.4** (guarded, OHLC-based volatility with stated uncertainty)
… 1.10 in order.

### Caveat for whoever picks this up

The four audit agents' full reports lived in a session-scoped scratchpad and are
**gone**. Their substance — file:line, evidence, numbers — is captured in this
document. If a finding here looks thin, re-derive it rather than trusting the
summary; two of the findings in the original audit were subtly mis-stated on
first pass and only became clear on independent verification.
