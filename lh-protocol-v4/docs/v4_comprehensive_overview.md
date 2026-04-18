# Liquidity Hedge Protocol v4: Comprehensive Mathematical Overview

## 1) Purpose and Scope

This document provides a rigorous and plain-English overview of protocol v4, with explicit formulas for:

- concentrated-liquidity (CLMM) position valuation,
- fair-value pricing of the corridor derivative used to hedge LP downside,
- LP hedger payoff,
- RT (risk taker / underwriter) payoff,
- statistical methodology used in v4 simulation.

It also includes a soundness audit stating what is mathematically correct, what is an implementation choice, and what currently needs correction.

---

## 2) Economic Product Definition

The protocol transfers part of an LP's downside exposure from a concentrated-liquidity position to a risk taker (RT):

- LP pays an upfront premium to buy protection over a downside corridor.
- RT receives premium (and fee share) and pays claims when corridor losses realize.
- The protected loss is defined on the CL position value function, not on linear spot returns.

This is important because CLMM loss is nonlinear and path-dependent in value space; a payoff directly linked to CL value is structurally closer to the LP's true risk than linear hedges.

---

## 3) CLMM Background and Liquidity Position Pricing Function

### 3.1 Variables

- `S`: SOL/USDC spot price at evaluation time.
- `S0`: entry spot price when hedge is bought.
- `ST`: terminal spot at expiry.
- `L`: liquidity parameter of the CL position.
- `pl`, `pu`: lower and upper range bounds of CL position.
- `V(S)`: CL position value in quote currency units.

### 3.2 CL Position Value Function

For a Uniswap v3 / Orca-style concentrated-liquidity position:

\[
V(S)=
\begin{cases}
L\left(\frac{1}{\sqrt{p_l}}-\frac{1}{\sqrt{p_u}}\right)S, & S\le p_l \\[6pt]
L\left(2\sqrt{S}-\frac{S}{\sqrt{p_u}}-\sqrt{p_l}\right), & p_l<S<p_u \\[6pt]
L\left(\sqrt{p_u}-\sqrt{p_l}\right), & S\ge p_u
\end{cases}
\]

Interpretation:

- Below range, position behaves like mostly base asset (approximately linear in `S`).
- In range, value is concave in `S` (mixed inventory).
- Above range, position is mostly quote asset (locally flat in `S`).

This function is the core object for risk transfer in the protocol.

---

## 4) Derivative Payoff Model (LP Hedger Protection)

### 4.1 Corridor Construction

- Barrier:
\[
B = S_0\left(1-\frac{\text{barrierBps}}{10000}\right)
\]
- Natural cap:
\[
Cap = V(S_0)-V(B)
\]

### 4.2 Payoff at Expiry

Define effective price floor:
\[
S_{\text{eff}}=\max(S_T, B)
\]

Then payoff to LP hedger is:
\[
\Pi(S_T)=\min\left(Cap,\ \max\left(0,\ V(S_0)-V(S_{\text{eff}})\right)\right)
\]

Interpretation:

- No payout when terminal state is above entry (`ST >= S0` in implementation).
- Partial payout for downside inside corridor.
- Max payout equals `Cap` once terminal state is below barrier.

---

## 5) Fair Value Methodology

### 5.1 Stochastic Model

The v4 simulation uses risk-neutral GBM-style terminal dynamics:

\[
S_T=S_0\exp\left(-\frac{1}{2}\sigma^2T+\sigma\sqrt{T}Z\right),\quad Z\sim\mathcal N(0,1)
\]

with weekly tenor `T = 7/365`.

### 5.2 Fair Value Definition

\[
FV = \mathbb E[\Pi(S_T)]
\]

### 5.3 Numerical Evaluation (Gauss-Hermite)

The expectation is computed via Gauss-Hermite quadrature:

\[
FV \approx \frac{1}{\sqrt{\pi}}\sum_{i=1}^{n} w_i \,\Pi(S_T(x_i))
\]
\[
S_T(x_i)=S_0\exp\left(-\frac{1}{2}\sigma^2T+\sigma\sqrt{T}\,x_i\sqrt{2}\right)
\]

Current v4 notebook uses `n = 128` nodes.

Statistical suitability:

- For smooth payoffs, GH is efficient and stable.
- Here payoff is piecewise but still well-behaved enough for GH to be appropriate.
- Node count should be standardized and validated against a Monte Carlo benchmark.

---

## 6) Premium Model Used in v4 Simulation

### 6.1 Variables

- `rv30`: trailing 30-day realized volatility estimate.
- `rv7`: trailing 7-day realized volatility estimate.
- `ivrv`: implied/realized volatility ratio proxy in simulation.
- `demand`, `supply`: hedge demand and RT underwriting capacity.
- `alpha_rv`, `alpha_ivrv`: volatility markup sensitivities.
- `k_lin`, `k_quad`: imbalance markup sensitivities.
- `y_share`: LP fee-share transferred to RT.
- `F`: realized LP fees over tenor.

### 6.2 Markup Components

Volatility markup:
\[
m_{vol}=\operatorname{clip}\left(1+\alpha_{rv}\left(\frac{rv30}{rv_{ref}}-1\right)+\alpha_{ivrv}(ivrv-1),\ [m_{vol}^{min},m_{vol}^{max}]\right)
\]

Imbalance markup:
\[
imb=\frac{demand}{supply}-1
\]
\[
m_{amm}=\operatorname{clip}\left(1+k_{lin}\,imb+k_{quad}\,\operatorname{sign}(imb)\,imb^2,\ [m_{amm}^{min},m_{amm}^{max}]\right)
\]

### 6.3 Premium Equation (Notebook Implementation)

\[
Premium = \max\left(0,\ FV\cdot m_{vol}\cdot m_{amm} - y_{share}\,\mathbb E[F]\right)
\]

where expected fees in simulation are:
\[
\mathbb E[F] = V(S_0)\cdot \text{expectedDailyFeeRate}\cdot 7
\]

Interpretation:

- First term prices actuarial/market/inventory risk.
- Second term discounts premium because RT also receives fee share at settlement.
- The `max(0, .)` floor prevents negative quotes.

---

## 7) LP and RT Payoff Models

### 7.1 LP Hedger PnL

Let:
\[
\Delta V = V(S_T)-V(S_0)
\]

Then LP weekly PnL in simulation:
\[
PnL_{LP} = \Delta V + (1-y_{share})F + \Pi - Premium
\]

Meaning:

- LP keeps only `(1 - y_share)` of realized fees.
- LP receives derivative payout `Pi` when downside occurs.
- LP pays upfront premium.

### 7.2 RT PnL

\[
PnL_{RT}=Premium + y_{share}F - \Pi
\]

In implementation, protocol fee is first deducted from premium before RT income is computed:
\[
Premium_{RT}=Premium\cdot(1-\text{protocolFeeRate}),\quad
PnL_{RT}=Premium_{RT}+y_{share}F-\Pi
\]

Meaning:

- RT earns premium and fee-share transfer.
- RT pays claims equal to derivative payout.

### 7.3 Capital Update Used in v4 Notebook

If `C_t` is RT capital:
\[
C_{t+1} = C_t \left(1 + r_{RT,t} + r_{idle}\right),\quad r_{RT,t}=\frac{PnL_{RT,t}}{C_t}
\]

In current simulation an additional constant idle-growth term is applied.

---

## 8) Statistical / Simulation Methodology

### 8.1 Scenario Engine

- Synthetic GBM path generation (`weeks` horizon).
- Rolling estimates for `rv7` and `rv30`.
- Parameter sweep over:
  - `alpha_rv`, `alpha_ivrv`,
  - `k_lin`, `k_quad`,
  - `yield_share_to_rt`,
  - `max_utilization`.

### 8.2 Main Metrics

- LP mean and median weekly return.
- RT mean weekly return.
- Competitiveness ratio:
\[
ratio_t = \frac{Premium_t / Cap_t}{MarketCostPerCap_t}
\]
- Feasibility rule (strict):
  - LP mean > 0,
  - RT mean > 0,
  - median ratio <= 1.
- Robustness rule:
  - 95th percentile ratio <= 1.10.

### 8.3 Suitability Assessment

What is suitable:

- GH fair value for this type of payoff.
- Explicit viability + competitiveness constraints.
- Parameter sweep to map feasible regions.

What is simplification:

- Constant market benchmark baseline in current notebook.
- Single-factor GBM and synthetic fee process.

---

## 8.4 Parameter Identification Algorithm (Explicit)

This is the exact methodology used to identify suitable protocol parameters from the candidate space.

### Step 0: Define parameter search space

Define a grid over governance/runtime controls:

\[
\Theta = \{\alpha_{rv}, \alpha_{ivrv}, k_{lin}, k_{quad}, y_{share}, u_{max}\}
\]

In the full-run notebook this is a Cartesian product of discrete candidate sets.

### Step 1: Simulate weekly market and contract economics for each parameter tuple

For each \( \theta \in \Theta \):

1. Generate (or reuse) simulated weekly spot path \(S_t\) under GBM assumptions.
2. Compute rolling \(rv7_t\), \(rv30_t\), and \(ivrv_t\) proxy.
3. Construct CL position and corridor payoff terms:
   \[
   Cap_t,\ \Pi_t,\ FV_t
   \]
4. Compute premium using:
   \[
   Premium_t = \max\left(0,\ FV_t \cdot m_{vol,t} \cdot m_{amm,t} - y_{share}\,\mathbb E[F_t]\right)
   \]
5. Compute LP and RT PnL:
   \[
   PnL_{LP,t}=\Delta V_t + (1-y_{share})F_t + \Pi_t - Premium_t
   \]
   \[
   PnL_{RT,t}=Premium_t(1-\text{protocolFeeRate}) + y_{share}F_t - \Pi_t
   \]
6. Compute competitiveness ratio:
   \[
   ratio_t = \frac{Premium_t / Cap_t}{MarketCostPerCap_t}
   \]

### Step 2: Aggregate objective statistics per parameter tuple

For each \( \theta \), compute:

- \( \mu_{LP} = \text{mean}(ret_{LP,t}) \)
- \( \mu_{RT} = \text{mean}(ret_{RT,t}) \)
- \( medRatio = \text{median}(ratio_t) \)
- \( p95Ratio = Q_{0.95}(ratio_t) \)

and optional diagnostics (for example, arbitrage-pressure proxy totals).

### Step 3: Hard feasibility filtering

Define strict feasibility indicator:

\[
I_{feasible}(\theta)=
\mathbf{1}\{\mu_{LP}>0\}
\cdot
\mathbf{1}\{\mu_{RT}>0\}
\cdot
\mathbf{1}\{medRatio\le 1\}
\]

Define robustness indicator:

\[
I_{robust}(\theta)=\mathbf{1}\{p95Ratio\le 1.10\}
\]

Parameter tuples that fail hard constraints are excluded from launch-candidate set.

### Step 4: Ranking among feasible tuples

Among feasible candidates, apply scalar ranking score:

\[
score(\theta)=\mu_{LP}+1.2\,\mu_{RT}-25\cdot\max(0,medRatio-1)
\]

Interpretation:

- Reward positive LP and RT mean returns.
- Penalize non-competitive pricing above market-normalized threshold.
- Keep scoring simple and transparent rather than overfitting a high-dimensional utility.

### Step 5: Select launch candidates and guardrails

From top-ranked feasible tuples:

1. pick best candidate;
2. inspect neighboring tuples for local stability (parameter robustness);
3. verify imbalance/arbitrage heatmaps do not indicate pathological one-sided mispricing;
4. set guardrails (`max_utilization`, ratio monitoring, stress multiplier behavior).

### Step 6: Post-selection validation

Run an out-of-grid or stress validation pass:

- perturb vol and imbalance regimes,
- check feasible set persistence,
- confirm no sign reversals in LP/RT mean returns under mild parameter perturbations.

This prevents selecting a brittle point that only works at one narrow grid coordinate.

---

## 9) Soundness Audit (Correct / Needs Correction / Open Assumption)

## 9.1 Correct

- CL value function used in v4 code is mathematically consistent with standard CLMM valuation.
- Corridor payoff is correctly defined as capped loss between entry value and barrier-floored terminal value.
- Fair value as risk-neutral expectation and GH evaluation is mathematically valid.
- LP and RT PnL accounting is internally consistent within the notebook's chosen cash-flow model.

## 9.2 Corrected During This Revision

1. **Cover-ratio scaling ambiguity in v3 methodology text**
   - Status: corrected in `[lh-protocol-v3/docs/pricing_methodology.md](lh-protocol-v3/docs/pricing_methodology.md)`.
   - Current consistent form:
     \[
     scaled\_payoff=\min(c\cdot Cap,\ raw)=c\cdot full\_corridor\_payoff
     \]
     for the capped corridor formulation.

2. **Barrier decoupling vs implementation**
   - Status: corrected in v4 notebook by removing the `max(B_raw, p_l)` clamp.
   - Barrier depth is now simulated independently from CL width.

3. **Premium formula mismatch across v4 docs**
   - Status: corrected in `[lh-protocol-v4/docs/methodology_and_guardrails.md](lh-protocol-v4/docs/methodology_and_guardrails.md)`.
   - Premium now documented consistently as:
     \[
     Premium=\max(0, FV\cdot m_{vol}\cdot m_{amm}-y_{share}\mathbb E[F])
     \]

4. **RT premium-fee treatment mismatch**
   - Status: corrected in v4 notebook by applying protocol-fee deduction before RT premium income.

## 9.3 Open Assumptions / Model Risk

1. **Quadrature-node inconsistency**
   - Status: corrected by standardizing v4 notebook quadrature to 128 nodes.

2. **Fixed market benchmark baseline (Low-Medium)**
   - v4 notebook uses fixed `market_cost_per_cap = 0.30`.
   - This is useful for controlled sweeps but may bias competitiveness if market regime changes.
   - Action: add time-varying benchmark or confidence-band stress inputs in production-grade analysis.

3. **Single-regime diffusion simplification (Low-Medium)**
   - GBM with short-horizon rolling vol is tractable but does not capture jumps/stochastic volatility fully.
   - Action: include stress scenarios and/or jump-vol sensitivity checks for robustness.

---

## 10) Practical Implications for v4 Design

- The corridor-on-CL-value architecture is conceptually sound for LP downside transfer.
- Feasibility must always be checked jointly for LP and RT, not LP alone.
- Pricing should preserve:
  - fair-value core,
  - market-risk loading,
  - inventory imbalance loading,
  - fee-share cash-flow consistency.
- Documentation and implementation should be made formula-consistent before production decisions.

---

## 11) Reproducibility and File References

Primary model and outputs:

- Notebook: `[lh-protocol-v4/notebooks/v4_research_synthesis.ipynb](lh-protocol-v4/notebooks/v4_research_synthesis.ipynb)`
- Summary JSON: `[lh-protocol-v4/notebooks/data/v4_summary.json](lh-protocol-v4/notebooks/data/v4_summary.json)`
- Sweep table: `[lh-protocol-v4/notebooks/data/v4_sweep_results.csv](lh-protocol-v4/notebooks/data/v4_sweep_results.csv)`
- Imbalance table: `[lh-protocol-v4/notebooks/data/v4_arb_frontier.csv](lh-protocol-v4/notebooks/data/v4_arb_frontier.csv)`
- Diagnostics plots:
  - `[lh-protocol-v4/notebooks/data/v4_sweep_diagnostics.png](lh-protocol-v4/notebooks/data/v4_sweep_diagnostics.png)`
  - `[lh-protocol-v4/notebooks/data/v4_arb_frontier_heatmaps.png](lh-protocol-v4/notebooks/data/v4_arb_frontier_heatmaps.png)`

Reference methodology sources:

- `[lh-protocol-v3/docs/pricing_methodology.md](lh-protocol-v3/docs/pricing_methodology.md)`
- `[lh-protocol-v3/docs/v3_design.md](lh-protocol-v3/docs/v3_design.md)`
- `[lh-protocol-v4/docs/methodology_and_guardrails.md](lh-protocol-v4/docs/methodology_and_guardrails.md)`
