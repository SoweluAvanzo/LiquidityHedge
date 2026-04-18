# Simulation Methodology and Design

Liquidity Hedge Protocol v2

---

## 1. Data Sources

### Birdeye OHLCV API

Primary price data is sourced from Birdeye's OHLCV API for the SOL/USDC pair:
- Endpoint: `https://public-api.birdeye.so/defi/ohlcv`
- Pair: SOL/USDC
- Granularity: 1-day candles
- Period: 1 year of daily data (approximately 365 data points)
- Fields used: open, high, low, close, volume

The close price is used as the representative daily price for return computation. High/low prices are used for intraday range estimation and in-range fraction computation.

### Orca Whirlpool

Live price is fetched from the SOL/USDC Whirlpool on Orca:
- Pool address: `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`
- Tick spacing: 64 (1% fee tier)
- Used for: current price reference, tick spacing validation, fee tier confirmation

### Volatility Computation

Realized volatility is computed from daily log returns:

    r_t = ln(close_t / close_{t-1})

Annualized volatility over a window of n days:

    sigma = std(r_1, ..., r_n) * sqrt(365)

Two windows are maintained:
- sigma_30d: trailing 30-day realized vol (used for fair value computation and dynamic severity)
- sigma_7d: trailing 7-day realized vol (used for the vol indicator in two-part pricing)

The 365-day annualization factor (not 252) is used because crypto markets trade every day, including weekends and holidays.

---

## 2. Realized Volatility Analysis

### Annual Summary

Over the 1-year data period, the SOL/USDC pair exhibited:
- Annualized realized volatility: 74%
- This is computed as the standard deviation of daily log returns, annualized by sqrt(365)

### Monthly Breakdown

Volatility varies substantially across months, reflecting distinct market regimes:

| Month | 30d Realized Vol (ann.) | Regime |
|---|---|---|
| Apr 2025 | ~62% | Moderate |
| May 2025 | ~58% | Moderate |
| Jun 2025 | ~55% | Low |
| Jul 2025 | ~60% | Moderate |
| Aug 2025 | ~68% | Moderate-high |
| Sep 2025 | ~75% | High |
| Oct 2025 | ~82% | High |
| Nov 2025 | ~95% | Very high |
| Dec 2025 | ~106% | Extreme |
| Jan 2026 | ~98% | Very high |
| Feb 2026 | ~72% | Moderate-high |
| Mar 2026 | ~57% | Moderate |

### Regime Interpretation

The monthly breakdown reveals:
- A 2x range in volatility (55% to 106%) across the year
- A clear volatile period from September 2025 through January 2026
- Return to moderate levels by March 2026

### Calibration Point

The 65% calibration point used in the heuristic formula represents a moderate regime, deliberately chosen below the full-year average of 74%. This is conservative in the sense that:
- It underestimates risk in average conditions, leading to lower premiums
- The dynamic severity mechanism compensates by adjusting severity upward when vol exceeds 65%
- The two-part premium's vol indicator further adjusts for short-term vol deviations

The choice of 65% rather than the 74% average reflects the protocol's design philosophy: base parameters should be set for "normal" conditions, with dynamic adjustments handling elevated conditions. This makes the floor/ceiling bounds more meaningful.

---

## 3. Backtest Methodology

### Rolling Window Design

The backtest uses rolling 7-day windows over the 1-year dataset:
- Window length: 7 days (matching the certificate tenor)
- Step size: 7 days (non-overlapping)
- Total windows: approximately 51 non-overlapping periods

Non-overlapping windows are used to ensure statistical independence between observations. Overlapping windows would inflate the sample size but introduce autocorrelation, making standard error estimates unreliable.

### Per-Window Procedure

For each 7-day window, the following steps are executed:

**Step 1: Position Recentering**

The CL position is recentered on the entry price (the close of the day before the window starts):
- S_0 = close price at window start
- p_l = S_0 * (1 - width) for the lower tick
- p_u = S_0 * (1 + width) for the upper tick
- Liquidity L is computed to produce a notional N at price S_0

This recentering simulates an LP who opens a fresh position at the start of each period, which is the realistic usage pattern: LPs recenter their positions when they buy a new certificate.

**Step 2: Natural Cap Computation**

    natural_cap = V(S_0) - V(p_l)

where V is the CL value function from the pricing methodology. This is the maximum loss the corridor certificate covers.

**Step 3: Fee Estimation**

Daily fee income is estimated from the in-range fraction:
- For each day in the window, the high/low range is checked against [p_l, p_u]
- If the daily range intersects the position range, fees accrue at the daily rate
- In-range fraction is estimated as the proportion of the day's range that overlaps with the position range

    daily_fees = notional * daily_fee_rate * in_range_fraction

    total_fees = sum of daily_fees over the 7-day window

Daily fee rates:
- +/-5% width: 0.65% per day
- +/-10% width: 0.45% per day

**Step 4: Trailing Volatility**

At window start, trailing volatilities are computed:
- sigma_30d: from the 30 daily returns preceding the window
- sigma_7d: from the 7 daily returns preceding the window

These are used for:
- Fair value computation (GH quadrature at sigma_30d)
- Vol indicator (sigma_7d / sigma_30d)
- Dynamic severity calibration

**Step 5: Strategy Computation**

All 9 strategies are computed on the same price path and position parameters. This ensures head-to-head comparisons are valid (same entry price, same fees, same terminal price).

**Step 6: Return Calculation**

Weekly return for each strategy is computed as:

    return = (terminal_value - initial_value) / initial_value

where initial_value includes any upfront premium paid, and terminal_value includes position value, fees earned, certificate payoff (if any), and settlement premium deducted (if applicable).

---

## 4. Strategy Definitions

### Strategy 1: Bond (Risk-Free Benchmark)

    weekly_return = (1 + 0.12)^(7/365) - 1 ≈ 0.22%

A constant 12% APY benchmark. All capital earns risk-free return. This represents the opportunity cost of deploying capital to LP or RT activities. The 12% rate corresponds to competitive DeFi lending rates on USDC.

### Strategy 2: Plain LP (Unhedged)

    initial_value = V(S_0)
    terminal_value = V(S_T) + total_fees
    return = (terminal_value - initial_value) / initial_value

The LP opens a CL position with no hedge. Returns are driven by:
- CL position value change: V(S_T) - V(S_0) (can be positive or negative)
- Fee income: total_fees (always positive)

This is the baseline against which hedged strategies are compared.

### Strategy 3: Hedged LP -- Fixed Premium (1.10x)

    premium = 1.10 * FairValue(sigma_30d)
    initial_value = V(S_0) + premium
    payoff = min(natural_cap, max(0, V(S_0) - V(max(S_T, B))))
    terminal_value = V(S_T) + total_fees + payoff
    return = (terminal_value - initial_value) / initial_value

The LP buys a corridor certificate at 1.10x fair value (full upfront payment). The premium is a sunk cost; the payoff compensates for CL losses.

### Strategy 4: Hedged LP -- Two-Part Premium (alpha = 0.4)

    vol_indicator = clip(sigma_7d / sigma_30d, 0.5, 2.0)
    P_upfront = 0.40 * FairValue(sigma_30d) * vol_indicator
    beta = (1.10 - 0.40) * FairValue(sigma_30d) / E[fees]
    P_settlement = beta * total_fees
    
    initial_value = V(S_0) + P_upfront
    payoff = min(natural_cap, max(0, V(S_0) - V(max(S_T, B))))
    terminal_value = V(S_T) + total_fees - P_settlement + payoff
    return = (terminal_value - initial_value) / initial_value

The LP pays a reduced upfront premium and has a portion of fees deducted at settlement. This reduces entry cost but shares upside with the pool.

### Strategy 5: Hedged LP + jitoSOL -- Two-Part Premium

Same as Strategy 4, but the SOL component of the CL position earns jitoSOL staking yield:

    jito_yield = SOL_fraction * jito_apy * 7 / 365

where:
- SOL_fraction: the fraction of the position value denominated in SOL at the average price during the window
- jito_apy: jitoSOL staking APY (approximately 7-8% annualized)

    terminal_value = V(S_T) + total_fees - P_settlement + payoff + jito_yield
    return = (terminal_value - initial_value) / initial_value

This models the realistic scenario where LPs use liquid staking tokens to earn additional yield on their SOL allocation.

### Strategy 6: RT v1 -- Pure Insurer (Two-Part Premium)

    premium_received = P_upfront + P_settlement  (from corresponding LP)
    payout = min(natural_cap, max(0, V(S_0) - V(max(S_T, B))))
    
    initial_value = pool_capital_reserved  (= natural_cap, the maximum liability)
    terminal_value = pool_capital_reserved + premium_received - payout
    return = (terminal_value - initial_value) / initial_value

The RT deposits USDC into the pool and underwrites certificates. Returns come from premium income minus claim payouts. The capital reserved equals the natural cap (maximum possible payout).

Note: In practice, the pool's utilization constraint (u_max = 30%) means each unit of pool capital supports multiple certificates. The returns shown here are per-certificate, assuming full capital reservation. Actual pool-level returns are amplified by the leverage ratio (1/u_max ≈ 3.3x).

### Strategy 7: RT v2 -- Productive (Two-Part Premium)

Same as Strategy 6, but the reserved USDC also earns yield in a lending protocol:

    lending_yield = pool_capital_reserved * lending_apy * 7 / 365

where lending_apy is approximately 8-10% (e.g., Solend/Kamino USDC lending).

    terminal_value = pool_capital_reserved + premium_received - payout + lending_yield
    return = (terminal_value - initial_value) / initial_value

This models the productive RT who deploys idle pool capital to lending markets, earning additional yield on top of premium income.

### Strategy 8: LP + Put Spread

    K1 = S_0       (ATM put)
    K2 = B          (OTG put at barrier)
    
    put_spread_premium = BS_put(K1, sigma_30d, T) - BS_put(K2, sigma_30d, T)
    put_spread_payoff = max(0, K1 - S_T) - max(0, K2 - S_T)
    
    initial_value = V(S_0) + put_spread_premium
    terminal_value = V(S_T) + total_fees + put_spread_payoff
    return = (terminal_value - initial_value) / initial_value

where BS_put(K, sigma, T) is the Black-Scholes put price:

    BS_put = K * N(-d2) - S_0 * N(-d1)
    d1 = (ln(S_0/K) + sigma^2/2 * T) / (sigma * sqrt(T))
    d2 = d1 - sigma * sqrt(T)

The put spread provides linear protection between S_0 and B. It overhedges for small moves and underhedges for large moves relative to the actual CL loss curve.

### Strategy 9: LP + Perpetual Delta Hedge

    delta_0 = dV/dS at S_0 = L * (1/sqrt(S_0) - 1/sqrt(p_u))
    
    For each day t in the window:
        hedge_pnl_t = -delta_{t-1} * (S_t - S_{t-1})
        delta_t = dV/dS at S_t (recomputed daily)
        funding_cost_t = abs(delta_{t-1} * S_{t-1}) * funding_rate / 365
    
    total_hedge_pnl = sum of hedge_pnl_t
    total_funding = sum of funding_cost_t
    
    initial_value = V(S_0)
    terminal_value = V(S_T) + total_fees + total_hedge_pnl - total_funding
    return = (terminal_value - initial_value) / initial_value

where funding_rate is the annualized perpetual funding rate (assumed 10% on average, reflecting typical SOL perp markets).

The delta is rebalanced daily. The hedge neutralizes first-order price exposure but leaves gamma (convexity) risk unhedged. The funding cost is the carry cost of the short perp position.

---

## 5. Metrics

### Definitions

All metrics are computed across the 51 weekly windows:

**Median Weekly Return (Med/wk)**

    Med/wk = median(return_1, return_2, ..., return_51)

The median is preferred over the mean for robustness to outliers. A few extreme weeks (crashes or rallies) can dominate the mean but leave the median relatively stable.

**Mean Weekly Return (Mean/wk)**

    Mean/wk = (1/51) * sum(return_i for i = 1 to 51)

Reported for completeness but interpreted with caution due to outlier sensitivity.

**Annualized Median Return (Ann med)**

    Ann_med = (1 + Med/wk)^52 - 1

Compounded annualization of the median weekly return. This represents the expected annual performance if median weekly conditions persist. Very high values (e.g., >100%) reflect the compounding of weekly returns and should not be interpreted as guaranteed future performance.

**Sharpe Ratio**

    Sharpe = (Mean/wk - rf_weekly) / std(return_1, ..., return_51)

where rf_weekly = (1 + 0.12)^(1/52) - 1 ≈ 0.218% is the weekly risk-free rate (from the 12% APY bond benchmark).

The Sharpe ratio measures risk-adjusted return. Values above 0.2 (weekly) indicate strong risk-adjusted performance. Negative Sharpe indicates the strategy underperforms the risk-free rate on a risk-adjusted basis.

Note: The bond strategy has Sharpe = 0.000 by construction (zero variance, return = risk-free rate).

**Maximum Drawdown (MaxDD)**

    MaxDD = min(return_1, ..., return_51)

Since each window is independent (non-overlapping, position recentered), the maximum drawdown is simply the worst single-week return. This is a conservative measure: it represents the worst-case weekly loss.

**5th Percentile Return**

    P5 = percentile(return_1, ..., return_51, 5)

The return at the 5th percentile of the weekly return distribution. Approximately the 2nd or 3rd worst week out of 51. This is a tail risk measure analogous to Value-at-Risk at the 95% confidence level.

**Probability of Positive Week (P(+))**

    P(+) = count(return_i > 0 for i = 1 to 51) / 51

The fraction of weeks with positive returns. A strategy with P(+) = 80% delivers positive returns in 4 out of every 5 weeks.

**Head-to-Head Win Rate**

    WinRate(A vs B) = count(return_A_i > return_B_i for i = 1 to 51) / 51

The fraction of weeks where strategy A outperforms strategy B. This is a paired comparison that controls for market conditions (both strategies face the same price path each week).

---

## 6. Monte Carlo Design

### Purpose

Monte Carlo simulation is used exclusively for fair value validation -- confirming that the Gauss-Hermite quadrature produces correct fair values. It is NOT used in the backtest (which uses historical prices) or in production pricing.

### Configuration

- Number of paths: 200,000
- Path type: terminal only (S_T drawn directly from log-normal distribution, no intermediate steps needed for European-style payoff)
- Drift: r = 0
- Volatility: sigma (parameter, varied from 30% to 100%)
- Tenor: T = 7/365 years

### Antithetic Variates

For each random draw Z_i, we also compute the path with -Z_i:

    S_T^+ = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * Z_i)
    S_T^- = S_0 * exp(-sigma^2/2 * T - sigma * sqrt(T) * Z_i)
    
    payoff_i = (payoff(S_T^+) + payoff(S_T^-)) / 2

This variance reduction technique exploits the symmetry of the normal distribution to reduce the standard error by approximately 30-40% compared to plain MC with the same number of draws.

### Standard Error

With 200k paths (100k antithetic pairs), the standard error of the MC estimate is:

    SE = std(payoff_i) / sqrt(100_000)

Typical SE values are 0.01-0.02% of Cap, which is well below the 0.1% precision needed for validation.

### Comparison with Gauss-Hermite

| sigma | GH-128 Fair Value (% Cap) | MC-200k Fair Value (% Cap) | Relative Diff |
|---|---|---|---|
| 30% | 1.52% | 1.52% | <0.01% |
| 50% | 4.82% | 4.83% | 0.02% |
| 65% | 7.96% | 7.95% | 0.01% |
| 80% | 11.54% | 11.53% | 0.01% |
| 100% | 17.12% | 17.11% | 0.01% |

Agreement is within MC standard error at all volatility levels, confirming the correctness of the GH quadrature implementation.

---

## 7. Width Configurations

### Overview

The width parameter defines the half-range of the CL position relative to the entry price:
- +/-5%: p_l = 0.95 * S_0, p_u = 1.05 * S_0
- +/-10%: p_l = 0.90 * S_0, p_u = 1.10 * S_0
- +/-15%: p_l = 0.85 * S_0, p_u = 1.15 * S_0 (evaluated but dropped)

Narrower widths concentrate liquidity more, earning higher fees per unit of capital but exposing the position to more frequent out-of-range events.

### +/-5% Width

| Parameter | Value |
|---|---|
| Barrier (B) | 0.95 * S_0 |
| Upper bound (p_u) | 1.05 * S_0 |
| Daily fee rate | 0.65% of notional |
| Natural cap | ~3.7% of notional |
| Fee share of premium | ~25% |
| p_hit at sigma=74% | ~853,000 PPM (85.3%) |

Characteristics:
- High fee income compensates for frequent barrier breaches
- Small natural cap means premiums are a small fraction of notional
- Fee share of 25% means in two-part pricing, roughly 25% of the total premium comes from the settlement component
- Suitable for LPs who want maximum fee generation and accept higher hedge costs relative to position size

### +/-10% Width

| Parameter | Value |
|---|---|
| Barrier (B) | 0.90 * S_0 |
| Upper bound (p_u) | 1.10 * S_0 |
| Daily fee rate | 0.45% of notional |
| Natural cap | ~7.4% of notional |
| Fee share of premium | ~20% |
| p_hit at sigma=74% | ~575,000 PPM (57.5%) |

Characteristics:
- Moderate fee income with lower barrier breach frequency
- Larger natural cap allows for more meaningful hedging
- Fee share of 20% means the settlement component is a smaller fraction
- Better suited for LPs seeking a balance between fee income and hedging cost

### +/-15% Width (Dropped)

| Parameter | Value |
|---|---|
| Barrier (B) | 0.85 * S_0 |
| Upper bound (p_u) | 1.15 * S_0 |
| Daily fee rate | ~0.30% of notional |
| Natural cap | ~11.1% of notional |
| Fee share of premium | ~12% |
| p_hit at sigma=74% | ~383,000 PPM (38.3%) |

Why it was dropped:
- Premium/fees ratio exceeds 2x at all volatility levels tested
- At sigma = 74%: premium ≈ 1.4% of notional, weekly fees ≈ 0.55% of notional (7 * 0.30% * in_range_fraction). The premium alone exceeds the expected fee income.
- At sigma = 50%: premium ≈ 0.7% of notional, weekly fees ≈ 0.67%. The hedge costs roughly the same as the entire fee income.
- The two-part premium model cannot function when beta would need to exceed 1.0 (deducting more than 100% of fees)
- Structurally unviable: the position is too wide to generate sufficient fees to justify the hedge cost

### Width Selection Guidance

| Scenario | Recommended Width |
|---|---|
| High-vol regime (sigma > 80%) | +/-5% (high fees offset frequent payouts) |
| Moderate-vol (sigma 50-80%) | +/-10% (balanced) |
| Low-vol (sigma < 50%) | +/-10% (premium is cheap, wider range stays in-range) |
| Maximum fee generation | +/-5% |
| Maximum capital protection | +/-10% (larger natural cap) |
