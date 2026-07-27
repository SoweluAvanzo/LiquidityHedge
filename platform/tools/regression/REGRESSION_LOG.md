# /api/portfolio regression log

Workflow (remediation plan, Phase 1 preamble): before each estimator
change, `node regress.mjs capture`; after deploying it, capture again,
`node regress.mjs diff <before> <after>`, explain every moved field here,
then `node regress.mjs accept <after>` to re-baseline.

Owner under regression: `6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj`
(4 real SOL/USDC positions, all in pool `Czfq3xZZ…`).

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
  gave measured/modelled = 1.0573 ($16,045 actual LP fees vs the model's
  understatement on $26.2M TVL). Direction: vendor 24h volume was stale
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
   0.0744%/day from $16,044.89 of LP fees on $26.2M vault TVL;
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
   truth). The pool-path cross-check attributed $0.000003 to EPRLfJkP
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
  — shows the largest correction: E[ΔV] −$0.000763 → −$0.000984, VI₂
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
