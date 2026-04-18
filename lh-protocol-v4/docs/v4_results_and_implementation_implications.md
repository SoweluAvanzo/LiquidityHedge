# v4 Results and Implementation Implications

## Scope

This document summarizes the latest quantitative outputs from:

- the v4 parameter-sweep simulation (`v4_sweep_results.csv`, `v4_summary.json`),
- the final historical validation section (`v4_final_backtest_2y.csv`),

and explains practical implications for protocol implementation and governance.

---

## 1) Simulation Results (Parameter Sweep)

Source artifacts:

- `lh-protocol-v4/notebooks/data/v4_summary.json`
- `lh-protocol-v4/notebooks/data/v4_sweep_results.csv`

Headline outputs:

- Total configurations evaluated: **486**
- Strict feasible configurations: **181**
- Robust feasible configurations: **181**

Top-ranked configuration (current scoring):

- `alpha_rv = 0.10`
- `alpha_ivrv = 0.40`
- `k_lin = 0.20`
- `k_quad = 0.10`
- `yield_share_to_rt = 0.15`
- `max_utilization = 0.60`

Top-config metrics:

- LP mean weekly return: **1.3930%**
- RT mean weekly return: **0.00944%**
- RT 5th percentile weekly return: **-0.0275%**
- `m_amm_mean`: **0.75**
- imbalance p95: **-0.9946**

Interpretation:

- The sweep finds a broad feasible region under the notebook assumptions.
- The best-scoring point is conservative on utilization and strong on volatility loading.
- The very negative imbalance percentile indicates supply-heavy states in this simulation setup; this is a modeling signal to monitor, not a production conclusion by itself.

---

## 2) Historical Validation (2-year Backtest)

Source artifact:

- `lh-protocol-v4/notebooks/data/v4_final_backtest_2y.csv`

Backtest setup in notebook:

- Evaluate top simulated candidates on historical weekly windows from ~2 years of daily SOL prices.
- Keep the same pricing/payoff equations as in simulation.
- Recompute LP/RT outcomes with historical path-dependent volatility and fee proxy.

Observed agreement between simulation ranking signals and backtest outcomes (15 candidate configs):

- LP mean return correlation (sim vs backtest): **0.2134**
- RT mean return correlation (sim vs backtest): **0.2673**
- LP sign agreement: **1.000**
- RT sign agreement: **0.2667**
- Mean absolute error (LP mean return, percentage points): **4.9522**
- Mean absolute error (RT mean return, percentage points): **0.00983**

Feasibility comparison:

- Simulation strict-feasible share (among evaluated candidates): **1.000**
- Backtest strict-feasible share: **0.2667**

Interpretation:

- Agreement is **weak-to-moderate** for fine ranking.
- Simulation appears useful for coarse filtering, but not sufficient alone for final deployment selection.
- Historical validation is therefore essential and should remain a mandatory final stage.

---

## 3) Implementation Implications

## 3.1 Governance and launch policy

- Use simulation sweep to define a **candidate region**, not a single immutable point.
- Treat launch parameters as **default governance settings**.
- Require a backtest pass before activating a parameter set.
- Keep post-launch governance ability to retune:
  - `alpha_rv`, `alpha_ivrv`,
  - `k_lin`, `k_quad`,
  - `yield_share_to_rt`,
  - `max_utilization`.

## 3.2 Runtime pricing behavior

- Even with fixed governance defaults, premium remains dynamic because:
  - volatility state changes `m_vol`,
  - demand/supply imbalance changes `m_amm` through the bonding-curve equation.

This design is correct and desirable: static governance defaults with dynamic runtime pricing.

## 3.3 Risk controls suggested by results

- Maintain conservative `max_utilization` at launch (e.g., around the feasible region found).
- Monitor imbalance and `m_amm` distributions; if persistent one-sided pressure appears, retune `k_lin`/`k_quad`.
- Keep backtest as a release gate whenever governance proposes major parameter updates.

---

## 4) Yield-Rate Assumptions (MC and Backtest)

The notebook currently includes two different yield-like assumptions:

1. **Idle RT capital growth term**
   - Implemented as:
     - `idle_yield_rate_day = 0.002`
     - `idle_yield_rate_week = (1 + idle_yield_rate_day)^7 - 1`
     - `rt_cap *= (1 + rt_ret + idle_yield_rate_week)`
   - This implies an additional **0.20% daily** drift on idle RT capital
     (about **1.41% weekly** under compounding).
   - Approx annualized equivalent:
     - \((1.002)^{365} - 1 \approx 107\%\)

2. **LP fee-rate assumptions**
   - Expected fee rate used in premium discount:
     - `exp_fee_rate_day = 0.0045` (0.45% daily)
   - Weekly expected fee rate used in pricing discount:
     - \(0.45\% \times 7 \approx 3.15\%\) weekly (on position value proxy).
   - Realized fee proxy in simulation:
     - stochastic around this expected level.
   - Realized fee proxy in backtest:
     - `realized_fee_day = clip(0.003 + 1.8 * mean(abs(window_log_returns)), 0.0005, 0.012)`.

Important note:

- These are modeling assumptions, not observed protocol APYs.
- They materially affect LP/RT economics and should be governance-visible parameters or calibration inputs.

---

## 5) 3-Strategy Breakeven Backtest (3 years)

Source artifacts:

- `lh-protocol-v4/notebooks/data/v4_strategy_breakeven_ranking_3y.csv`
- `lh-protocol-v4/notebooks/data/v4_strategy_breakeven_ranking_3y.png`

Strategies compared:

- Fixed perp hedge on CL exposure (50% initial SOL exposure hedged weekly).
- Dynamic perp hedge (hedge ratio updated every 1/10th range move).
- Protocol corridor hedge (LP hedger + RT under viable-region pricing parameters).

Latest headline results:

- `protocol_corridor_lp_rt`: breakeven **88.60 bps/week**, LP mean **1.027%/week**, RT mean **0.00006%/week**.
- `fixed_perp_half_hedge`: breakeven **57.10 bps/week**, LP mean **0.706%/week**.
- `dynamic_perp_decile_hedge`: breakeven **1.42 bps/week**, LP mean **0.120%/week**.

Apples-to-apples cost assumptions now applied:

- **Protocol strategy**
  - explicit execution cost on LP side: **2 bps open + 2 bps settle per week** (4 bps/week total),
  - protocol premium fee rate to treasury: `protocol_fee_rate = 1.5%`.
- **Perp strategies**
  - explicit trading cost: `tx_cost_bps = 2.0` on each hedge trade,
  - funding is now **historical daily series** from Binance SOLUSDT perpetual funding history (8h rates aggregated to daily), not a fixed assumed constant in the primary run.
- **Spot data source in latest executed run**
  - Birdeye endpoint failed in this environment, so spot backtest used Binance daily SOLUSDT fallback, while funding still used Binance futures historical funding.

How to interpret breakeven correctly:

- In this notebook, `breakeven_bps_per_week = 10,000 * E[LP weekly PnL] / E[V0]`.
- It measures how much **additional external weekly cost** (on CL notional) the LP strategy can absorb before LP mean PnL reaches zero.
- Therefore, **higher is better for LP cost tolerance** under this definition (more cushion), not worse.
- A negative breakeven means the strategy is already near/below LP zero-PnL and cannot absorb extra costs.

Important caveat for protocol interpretation:

- A high LP breakeven alone does **not** mean the protocol is globally best.
- For protocol launch, LP and RT must be jointly viable.
- In the latest apples-to-apples run, the selected protocol point is jointly viable (LP mean > 0 and RT mean > 0), but RT margin is still very thin and should be stress-tested.

Implication:

- Use this 3-strategy ranking as an LP-side robustness lens, then apply the protocol joint viability gate (LP > 0 and RT > 0) before governance approval.
- Evaluate all viable protocol configurations on historical data (not only the top simulation point): the latest run tested **180 viable configurations**, of which **24** were jointly viable in backtest.

---

## 6) Practical Recommendations

1. Keep the two-stage process:
   - Stage A: simulation sweep for candidate-region discovery.
   - Stage B: historical validation for shortlist confirmation.
2. Promote a config to launch-default only if it passes both:
   - strict/robust simulation feasibility,
   - acceptable backtest feasibility and stability.
3. Make yield and fee assumptions explicit in governance proposals, because they directly influence viability conclusions.
4. Add periodic revalidation (e.g., monthly) with rolling historical windows to reduce regime-drift risk.

---

## References

- `lh-protocol-v4/notebooks/v4_research_synthesis.ipynb`
- `lh-protocol-v4/notebooks/data/v4_summary.json`
- `lh-protocol-v4/notebooks/data/v4_sweep_results.csv`
- `lh-protocol-v4/notebooks/data/v4_final_backtest_2y.csv`
- `lh-protocol-v4/notebooks/data/v4_strategy_breakeven_ranking_3y.csv`
- `lh-protocol-v4/notebooks/data/v4_protocol_viable_config_backtest_3y.csv`
