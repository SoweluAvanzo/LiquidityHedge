# v4 Synthesis Methodology and Guardrails

## Core Definitions

- Underlying dynamics: weekly-horizon GBM with risk-neutral drift.
- Hedge payoff: capped CL loss between entry and barrier (barrier-depth independent from CL width in v4 simulation).
- Fair value: expected payoff via 128-node Gauss-Hermite quadrature.
- Premium (simulation): `max(0, FV * vol_markup * amm_multiplier - y_share * E[fees])`.
- RT premium income (simulation): `premium * (1 - protocol_fee_rate)`.

## Viability Criteria

- LP mean weekly return > 0.
- RT mean weekly return > 0.
- Median normalized corridor/market cost ratio <= 1.0.
- Robustness: 95th percentile normalized ratio <= 1.10.

## Runtime Guardrails

- Keep utilization within configured `max_utilization`.
- Monitor ratio drift and temporarily tighten pricing multipliers during stress.

## Data Sources Used

- Option calibration: `lh-protocol-v3/notebooks/data/sol_option_calibrated_params_latest.json`.
- Cross-check references:
  - `lh-protocol-v3/docs/pricing_methodology.md`
  - `lh-protocol-v3/docs/v3_design.md`
