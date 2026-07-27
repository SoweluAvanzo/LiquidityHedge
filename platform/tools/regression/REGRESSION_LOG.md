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
