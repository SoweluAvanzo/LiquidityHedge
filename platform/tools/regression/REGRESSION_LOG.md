# /api/portfolio regression log

Workflow (remediation plan, Phase 1 preamble): before each estimator
change, `node regress.mjs capture`; after deploying it, capture again,
`node regress.mjs diff <before> <after>`, explain every moved field here,
then `node regress.mjs accept <after>` to re-baseline.

Owner under regression: `6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj`
(4 real SOL/USDC positions, all in pool `Czfq3xZZ…`).

Captures are LOCAL artifacts (gitignored since 2026-07-28 — they are
verbatim public chain state, but their base58 addresses trip secret
scanners and they grow without bound); the committed record is this
log plus `golden/portfolio.json`.

Live prices move between captures, so a diff is never empty — the diff
prints the spot move first; the question for every other field is "is
this the code change or the market?".

---

## 2026-07-27 · Baseline (pre-Phase-1)

Golden: capture `portfolio-raw-20260727T134512.json` at commit `a7ebc83`
(Phase 0 + fee reader complete; estimator chain unchanged — Birdeye
modelled r_pool × in-range fraction × concentration factor, MC FV at
20k paths seed 1).

**Noise floor** (two captures 7 minutes apart, spot −0.020%):

- Most viability fields move < 0.7% per 0.02% of spot — dominated by
  `E[ΔV]`'s price sensitivity and Birdeye's TVL flutter.
- `concentrationFactor` moved −0.44% on NO position change: that is pure
  vendor TVL noise in `c = (L_pos × TVL)/(L_active × V_pos)` — the term
  step 1.1/1.2 replaces.
- `inRangeEstimate.divergence` moved ±19%: it is a small difference of
  two similar estimates; treat large relative moves there as expected.
- All 4 positions currently sit just BELOW their ranges (spot ≈ 76.55,
  lowest priceLower ≈ 76.64), so `bound = "floor"`, FV = 0 (clamped),
  and measuredDailyYield is entirely `r_pool × f × c` with f ≈ 0.42–0.45
  from the empirical estimator.

---

## 2026-07-27 · §1.1 — measured pool yield from feeGrowthGlobal snapshots

Diff: `captures/2026-07-27T12-05-40-723Z.json` (old code) →
`captures/2026-07-27T12-05-57-266Z.json` (deployed), spot +0.000%.

Every movement explained:

- **`poolDailyYield` +5.73%** (0.0006996 → 0.0007396): THE change. The
  Birdeye model `volume₂₄ₕ × lpFeeTier / TVL` is replaced by direct
  measurement `Σ Δ feeGrowthGlobal × L_active / 2⁶⁴ ÷ TVL_vaults` over
  81 snapshot intervals, 20.0h covered, zero gaps. The +5.73% IS the
  measured vendor error — an offline check of the same snapshot table
  gave measured/modelled = 1.0573 (\$16,045 actual LP fees vs the model's
  understatement on \$26.2M TVL). Direction: vendor 24h volume was stale
  relative to the realised fee run-rate of the last 20h.
- **`measuredDailyYield`, `viabilityIndex`, `twoSided.viabilityIndex`
  +5.75%** on all 4 positions: linear pass-through of r_pool (the extra
  +0.02% is c, next line).
- **`concentrationFactor` +0.02%**: TVL input for c switched from
  Birdeye's estimate to exact on-chain vault balances
  (`tvlSource: "onchain-vaults"`). Birdeye happened to be near-exact at
  this instant; the −0.44% flutter seen in the baseline noise-floor
  capture is what this removes going forward.
- **New `poolYield` wire block** (`source`, window, intervals,
  `fallbackReason`, `tvlSource`): provenance now travels to the UI;
  `undefined -> …` diff lines are the block appearing, not a value move.
- All other fields ±0.01% — σ re-fetch jitter between captures.

Uncertainty note: the measurement window is 20.0h (the collector's whole
history). The window and interval count are on the wire; the estimate
tightens automatically as history accumulates toward the 7-day lookback.

Golden re-baselined to the 12-05-57 capture.

---

## 2026-07-27 · §1.2 — position-level realised yield machinery deployed

Diff: `captures/2026-07-27T12-14-08-620Z.json` →
`captures/2026-07-27T12-14-43-817Z.json`, spot +0.018%.

- **New `positionYield` wire block** on all 4 positions:
  `source: "modelled-chain"`, `fallbackReason: "position history too
  short (1 snapshot(s) in the last 168h)"`. This is the DESIGNED state:
  the realised path (`L × Δ feeGrowthInside / 2⁶⁴` over ≥ 6h of
  snapshots) refuses to serve until history exists; the modelled
  r_pool × f × c chain remains the labelled fallback. No served number
  changed because of the 1.2 code today.
- Infrastructure now live: `lh.tracked_positions` auto-registered all 4
  positions on the first dashboard request; `lh.position_fee_snapshots`
  received their first opportunistic readings; the collector snapshots
  every tracked position each 15-min cycle from here on.
- All numeric movements are market drift: `poolDailyYield` +0.49% (one
  more 15-min interval landed in the measured window: 82 → 83),
  σ +0.06% (candle refresh), spot +0.018% pass-through, and the usual
  `inRangeEstimate.divergence` noise (small difference of two similar
  numbers).
- Expected follow-up: once ≥ 6h of position history accumulates,
  `positionYield.source` flips to `"realised-inside"` and
  `measuredDailyYield` becomes the position's own realised figure —
  for the CURRENT out-of-range positions that number will be near zero,
  which is measured truth (they earn nothing out of range), not a bug.
  That flip will be captured and explained here when it happens.

Golden re-baselined to the 12-14-43 capture.

---

## 2026-07-27 · Live-chain verification of §1.1 + §1.2 (all passed)

1. **§1.1 math vs live table** (offline recomputation, scratchpad): the
   snapshot-derived yield over 19.74h of gapless coverage was
   0.0744%/day from \$16,044.89 of LP fees on \$26.2M vault TVL;
   Birdeye-modelled same instant: 0.0704%/day → measured vendor error
   +5.7%, consistent with the calculation audit's earlier window.
2. **§1.1 reproducibility**: served `poolDailyYield`
   0.0007434272880355007 (83 intervals, 73007s) re-derived
   independently from `lh.pool_snapshots` → 0.0007434272880355007,
   bit-for-bit. The dashboard number is reproducible from the data we
   sell — the §1.1 acceptance criterion.
3. **§1.2 snapshots vs chain** (`pnpm --filter @lh/ops-jobs
   verify-positions`, new permanent CLI): for all 4 positions, the
   stored `feeGrowthInside` matches an INDEPENDENT live read through
   the fee-reader path (mint → PDA, finalized commitment) bit-for-bit;
   web-written and collector-written rows agree bit-for-bit; realised
   fees over the stored window are exactly 0 (out of range — measured
   truth). The pool-path cross-check attributed \$0.000003 to EPRLfJkP
   via its ½-crossing approximation near the window edge — the exact
   error class the position accumulator eliminates.

---

## 2026-07-27 · Post-audit fixes deployed (two adversarial verifier agents)

Diff: `captures/2026-07-27T12-40-41-225Z.json` →
`captures/2026-07-27T12-41-00-046Z.json`, spot ±0.000%.

Fixes in this deploy (see 06_remediation_plan.md STATUS for the full
audit list): staleness gates (1h max window age) on both measured
paths; realised path re-specified as IN-RANGE intensity × forward
occupancy (the trailing-realisation-in-a-forward-formula estimand
error); torn-read gates on feeGrowthInside (collector + discovery);
current-liquidity suffix; relative plausibility ceiling; simulate
constant-mode provenance; registration hardening; finite guards;
honest prov keys.

Every movement explained:

- **`poolYield.lastT` / `positionYield.lastT` appear** — the window's
  end time now travels on the wire (staleness is additionally gated
  server-side; `undefined -> …` lines are the fields appearing).
- **`poolDailyYield` +1.09%**, decomposed offline on identical rows:
  the L-midpoint fix alone moves the measurement **−0.18%** (downward,
  the direction the audit's bias analysis predicted: endpoint-average
  liquidity halves the upward first-order error), and one more 15-min
  interval landing (84 → 85, an active-fee interval) moves it +1.27%.
  Net +1.09% as observed.
- `concentrationFactor` +0.17%: fresher vault TVL (new snapshot).
- `measuredDailyYield` and both VIs +1.24–1.26%: linear pass-through
  of the two above. The realised path is still (correctly) inactive —
  `positionYield.source: "modelled-chain"`, coverage ~0.5h < 6h.
- Everything else ≤ 0.06%: σ/candle jitter, spot unchanged.
- Collector cycle after the deploy: `positions: captured 4/4, wrote 4`
  — the torn-read stability gate passes cleanly in production.

Golden re-baselined to the 12-41-00 capture.

---

## 2026-07-27 · §1.3 — deterministic quadrature for FV and E[ΔV]

Diff: `captures/2026-07-27T12-56-58-834Z.json` (seeded 20k-path MC) →
`captures/2026-07-27T12-57-20-628Z.json` (Simpson quadrature, the
paper's §3.2 method via `quadratureExpectation`, shared with the hedge
quote path — differential parity suite confirms computeQuadratureFV is
bit-identical after the refactor). Spot −0.035%.

Every movement explained:

- **`twoSided.expectedValueChangeUsd` −2.15% / −2.56% / −29.10% /
  −2.1%** across the 4 positions: THE change — the seed-1 MC bias
  eliminated. E[ΔV]'s MC variance was dominated by a linear term with
  zero expectation (8–108% SE); the quadrature resolves that term to
  ~1e-9 (martingale identity, asserted in tests). 38uAbrUp — the
  position the audit cited (VI₂ spanning 3.90–12.66 on the seed alone)
  — shows the largest correction: E[ΔV] −\$0.000763 → −\$0.000984, VI₂
  0.923 → 0.806. The MC had been flattering it by ~13%.
- `twoSided.breakeven`/`unhedgedBreakeven` move linearly with E[ΔV];
  one-sided VI moves ±0.3–0.7% (market only: spot −0.035%, empirical f
  refresh).
- `fairValueUsd` unchanged at 0 within the captures (positions
  hovering at their lower bound; the clamp behaves identically in both
  methods). NOTE: positions re-entered range around this deploy (spot
  76.84 > lower 76.64) — `feeOwedA` is ticking again; expect the
  realised-yield flip once 6h of in-range history accrues.

**Stability check (plan: "verify VI₂ is seed-invariant"):** two
captures 31s apart, spot +0.000% → every twoSided field moves ≤ 0.01%
(σ candle-refresh jitter only). There is no seed left to vary; the
12-minute badge-flip pathology (mGADEK) is now impossible from
estimator noise — remaining flips are genuine market moves (badge
hysteresis is §1.7's job).

Golden re-baselined to the 12-57-51 capture.

---

## 2026-07-27 · §1.4 — Garman–Klass σ with stated uncertainty

Diff: `captures/2026-07-27T13-18-04-888Z.json` →
`captures/2026-07-27T13-18-24-616Z.json`, spot +0.035%.

- **`sigmaAnnualized` +18.26%** (0.4391 → 0.5192): the change under
  test. Decomposed by independent recomputation on the same candles:
  partial-candle drop alone moves CC 0.4391 → 0.4458 (+1.5%); the
  CC → GK estimator switch moves 0.4458 → 0.5192 (+16.5%).
  **Independently corroborated**: Parkinson (a third, range-based
  estimator) gives 0.4985 on the same 30 bars — the two range
  estimators agree against the close-based one. The driver is in the
  raw data: mean daily high–low range 3.96% vs mean |close move|
  1.80% — closes systematically miss intraday variance.
- **New wire fields**: `sigmaBand` [41.4%, 62.7%] (90%, seeded block
  bootstrap), `sigmaMethod: "garman-klass"`, `sigmaDays: 30`. Note the
  band COVERS the old CC value — the estimator disagreement is inside
  σ's own stated uncertainty.
- **E[ΔV] −41% to −45%**, VI₂ −27% (EPRL 0.41 → 0.30): pure σ²
  pass-through (1.1826² ≈ 1.40) — divergence loss scales with
  variance. One-sided VI ±0.9% only (floor-bound; f rises slightly
  because higher σ raises re-entry probability for these
  just-out-of-range positions).

**Methodological flag for the owner (feeds 1.6/1.7 and D-review):**
GK⁄CC = 1.16 means the GBM within-bar assumption is violated
(intraday mean-reversion / chop). Range-based σ measures the intrabar
quadratic variation; close-based σ measures what the 7-day TERMINAL
distribution compounds from. Under chop, GK may overstate tenor-scale
vol. The plan prescribed GK and the band states the spread honestly,
but whether corridor pricing should use range- or close-based σ (or a
blend) is a measure-level choice the same class as 1.6 — recorded
here rather than decided silently. Also: the hedge QUOTE path's σ
(regime updater, CC-guarded + Binance IV) now differs from the card's
GK σ — reconciliation belongs to 1.8's getPricingParams.

Golden re-baselined to the 13-18-24 capture.

---

## 2026-07-27 · §1.5 — honest uncertainty on the empirical in-range fraction

Diff: `captures/2026-07-27T13-36-01-782Z.json` →
`captures/2026-07-27T13-36-20-841Z.json`, spot +0.087%.

- **New fields, no estimate change by construction**: the bootstrap
  only DESCRIBES the estimate. `meanCi` (90% moving-block bootstrap on
  the mean, blocks = 2× horizon, seeded) e.g. EPRL [0.421, 0.546] —
  compare the outcome band's [0, 1], which the card previously showed
  as if it were the uncertainty. `nEffective: 51` (= 358 windows ÷ 7:
  adjacent windows share 6 of 7 days). The verbatim description now
  states "≈51 effective — windows overlap 6 of 7 days" so the raw
  window count can no longer overstate the evidence.
- Card: the in-range prov line now shows the mean CI + n_eff; the
  single-window outcome spread moved to the tooltip, labelled as
  outcome spread, not estimate precision.
- `fraction` +0.9–1.6% and everything downstream: MARKET, not code —
  spot +0.087% with all four positions hugging their lower bounds; the
  GBM reference fraction moved the same +1.7–1.9%, which is the
  fingerprint of a spot-driven move (a code-driven one would move only
  the empirical leg).
- Shared bootstrap util extracted (§1.4's GK now uses it): verified
  bit-identical on live candles — σ 0.5192458481443899, band
  [0.4142554698863901, 0.626896211553188], exact match pre/post
  refactor.

Golden re-baselined to the 13-36-20 capture.

---

## 2026-07-27 · §1.6 + D5 — tenor-scale σ and the drift-sensitivity sweep

Diff: `captures/2026-07-27T14-01-41-142Z.json` →
`captures/2026-07-27T14-01-59-981Z.json`, spot +0.064%.

**The D5 measurement (1y of complete SOL dailies, coverage 100%):**
daily GK annualised 78.5%, daily CC 70.9%, weekly NON-overlapping
(n=52) **62.0%** [52.0–72.0]. VR(2) = 0.995 (random walk holds
day-to-day), **VR(7) = 0.76** (it breaks by the week — daily moves
partially cancel). GK-daily sits OUTSIDE the weekly measurement's 90%
band: daily-annualised σ of ANY flavour overstates 7-day terminal
dispersion on this asset.

Movements explained:

- **`sigmaAnnualized` −22.4%** (0.519 → 0.403): σ = 30d GK ×
  tenorAdjust 0.776 (= weekly₁ᵧ 0.610 ÷ GK-daily₁ᵧ 0.786). All four
  inputs travel on the wire (`sigmaTenorAdjust`) and the card tooltip
  derives the number in words. `sigmaDaily` keeps the unadjusted
  figure. Band scaled by the same factor (joint propagation is §1.7).
- **`twoSided.expectedValueChangeUsd` +37.9%** (−0.0118 → −0.0073):
  σ² pass-through (0.776² = 0.602 ✓). VI₂ EPRL 0.352 → 0.586. The
  previous divergence-loss figures were overstated by pricing 7-day
  dispersion off daily-annualised vol.
- **New `driftSensitivity`**: E[ΔV] at ∓50%/yr physical drift =
  −$0.0214 … +$0.0065 for EPRL — the sweep the plan's own table
  demanded; the risk-neutral point is visibly the middle of a
  drift-dominated interval, labelled as such on the card.
- `concentrationFactor` +6.09%: MARKET — active liquidity at the
  current tick shifted between captures (L is tick-quantized; spot
  crossed near 76.8–76.9). §1.6 does not touch c.
- `reference.fraction` +3.3%: GBM in-range fraction under the LOWER σ
  (less dispersion → more stay-in-range probability). Empirical
  fraction +0.9% is the spot move. `divergence` +30% follows from the
  two legs moving apart.
- `positionYield` coverage 1.7 → 1.8h: §1.2 history accruing on
  schedule; the ≥6h realised flip still expected ≈18:15.

Golden re-baselined to the 14-01-59 capture.

---

## 2026-07-27 · §1.7 — uncertainty propagated into both indices; CI dead-band verdicts

Diff: `captures/2026-07-27T15-33-05-782Z.json` →
`captures/2026-07-27T15-33-26-499Z.json`, spot ±0.000%.

- **Point values moved 0.00%** across every field: the refactor routes
  the point estimate and all perturbation legs through ONE
  `evaluateIndices` path, and the diff proves it value-preserving.
- **New `viabilityIndexBand` on both indices** — 90% interval from the
  three quantified inputs (σ band; empirical in-range mean CI;
  fee-flow bootstrap on the measured yield), each re-evaluated through
  the same computation and combined in quadrature. EPRL: VI₁ 0.072
  [0.049–0.091] (resolved critical); **VI₂ 0.867 [0.470–1.444] — the
  interval SPANS breakeven**, so the card now says "borderline
  (interval spans breakeven)" instead of asserting a verdict a 0.17%
  price move could flip. That is the measured mGADEK pathology closed
  by construction: verdicts change only when the whole band clears a
  threshold (statistically-principled, stateless hysteresis).
- `uncertaintyDominatedBy: "sigma"` on all 4 — the plan's own
  prediction ("σ dominates; a one-dimensional delta method suffices"),
  now measured per-position and shown as "band driver" on the card.
- Unquantified sources stay honest: on the Birdeye yield fallback the
  yield leg is EMPTY (band omits it) rather than pretending zero
  error; new bootstrap CIs (`dailyYieldCi` on the pool measurement,
  `feesQuoteCi` on position fees, both seeded ~1h blocks) cover the
  measured paths.
- Market context: SOL fell to 75.24 between 1.6 and 1.7 — positions
  are OUT of range again; the §1.2 realised flip (~18:15) will now
  land with fresh out-of-range history in the window, which the
  in-range-intensity estimand handles correctly by construction.

Golden re-baselined to the 15-33-26 capture.

---

## 2026-07-27 · §1.8 + §1.9 + §1.10 — pricing params, out-of-range state, prediction log v2

Diff: `captures/2026-07-27T16-05-53-316Z.json` →
`captures/2026-07-27T16-06-21-985Z.json`, spot −0.074%.

- **§1.8, new `pricingParams` block**: the parameters the card actually
  priced with, from the ONE `getPricingParams` module the quote path's
  `buildConfig()` now also consumes. Live values at deploy:
  `effectiveMarkup 1.05` (floor binds — live IV/RV 0.926 from
  `binance:SOL-260731-76-C`, `ivFallbackUsed: false`), fee split 0.10,
  floor \$0.05, φ 1.5%, tenor 7d. The dashboard's hardcoded 1.08 markup
  (A7/D-5: a certificate nobody would be quoted) is gone. Numerically
  free today: FV = 0 out of range → premiums floor-bound under either
  markup. D1 settled: the \$1.50 constant renamed
  `LEGACY_DEFAULT_PREMIUM_FLOOR_USDC` in @lh/core with a comment
  pointing at the live source.
- **§1.9 (D2b)**: `concentrationFactorSource: "measured"` on the wire;
  the CARD now shows "OUT OF RANGE — indices suppressed" with the
  forward re-entry expectation instead of indices that invite
  comparison with in-range positions — live right now for all 4
  positions (SOL at 75.2 vs lower bounds ~76.6).
- **§1.10**: prediction log records are v2 — actual bounds + spot
  (any width convention re-derivable), BOTH estimators' fractions
  like-for-like on those bounds, empirical mean CI + n_eff, method and
  fraction served. The v1 mismatch (midpoint-convention widthBps next
  to actual-bounds gbmFraction, F12) is gone. Like-for-like of the
  divergence flag CONFIRMED by a new cross-validation test: on
  synthetic GBM with a deliberately asymmetric range (−4%/+12%),
  empirical-bounds ≈ GBM-bounds within 3%.
- All numeric movement is the spot move: empirical f −1.41% and GBM
  reference −2.36% moved in lockstep (the spot-driven fingerprint);
  indices follow linearly; bands re-derive.

Golden re-baselined to the 16-06-21 capture.

---

## 2026-07-28 · §1.2 realised-yield FLIP observed (the last Phase-1 loose end)

Evidence: `captures/2026-07-28T09-17-06-828Z.json` (pre-deploy). The
host slept 21:00→morning (collector frozen mid-loop, gap correctly
EXCLUDED from covered time — windowSeconds 75745 vs coveredSeconds
21876); coverage crossed the 6h gate at the ~09:15 collector cycle and
`positionYield.source` flipped to **"realised-inside"**:

- covered 6.08h, of which 0.92h in range; realised fees \$0.000267.
- Realised in-range intensity ≈ **0.43%/day** — ~3× the modelled
  pool×c chain (0.14%/day). Not a bug: the in-range stretch happened
  at the range EDGE, where the position's liquidity density (and so
  its fee share) peaks — exactly the concentration reality the
  modelled first-order c underestimates. It is measured, labelled,
  and carries a wide fee-bootstrap band (`uncertaintyDominatedBy:
  "yield"`, VI₂ band [0.44, 8.81] — 0.92h of in-range evidence is
  thin and the band says so).
- With it, VI₁ 0.177 / VI₂ 3.58 momentarily served — then the same
  deploy's D2b server suppression correctly nulled the indices (all
  positions far out of range at SOL ≈ 73.3).

---

## 2026-07-28 · Phases 2–5 + paper-verifier fixes deployed

Diff: `captures/2026-07-28T09-17-06-828Z.json` →
`captures/2026-07-28T09-17-35-206Z.json`, spot ±0.000%.

- **`rangeState: "out-of-range"` appears; both indices + bands →
  null** (D2b/F2, now SERVER-side; wire docs state null = suppressed
  here, not ∞). The pre-deploy capture had just demonstrated the
  hazard this closes: VI₂ 3.58 served for an out-of-range position.
- **Estimator description reworded** (paper verifier #1 display
  finding): "for a range holding this position's own offsets from
  today's price (NOT re-centred)" — the old text described the
  spot-centred estimator whose bias was removed in Phase 1.
- **`reference.fraction` +12.7%, divergence −30%** (F5): the GBM
  reference is now DISCRETE at steps 1..7 — the empirical estimand —
  instead of a continuous average including P(0); the removed
  half-step bias had been inflating the model-divergence flag.
- **`sigmaBand` widens both sides** (p05 −7%, p95 +5.6%; F4b): the D5
  tenor-ratio's own sampling error (±16%, n=52 weekly returns) now
  combines in quadrature instead of being treated as exact.
- Market drift: poolDailyYield −0.66% (new interval), ivRvRatio
  0.99 → 0.97 (live Binance), position intervals 45 → 46.
- Not visible in this endpoint but in the same deploy: B1 coverage
  quote on orders, B7 token-safe download, C2/C3/C4/C8 settlement
  gates, quote-path σ unified with the card (F1), prediction-log v2
  already live, docs corrected (worked example \$0.38 → \$0.781).

Golden re-baselined to the 09-17-35 capture.
