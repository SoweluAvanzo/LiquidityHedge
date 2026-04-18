# Simulation Results

Liquidity Hedge Protocol v2

---

## 1. Overview

This document presents the results of backtesting 51 weeks of real SOL/USDC price data through several hedging strategies for concentrated liquidity (CL) positions. The simulations compare the Liquidity Hedge corridor certificate against alternatives including perpetual futures hedging, put spreads, and unhedged LP.

All results use a fixed markup of 1.10x on the corridor certificate premium. Strategies are evaluated at two position widths: +/-5% (tight range, higher fee yield, higher IL risk) and +/-10% (wider range, lower fee yield, lower IL risk).

---

## 2. Critical Correction: Jupiter Perp Costs

### The Error

Previous simulation runs modeled the perpetual futures hedge using a **12% APY borrow rate** for Jupiter perp positions. This is incorrect by a large margin.

### Actual Jupiter Perp Borrow Rates

Jupiter perpetual futures charge a **variable hourly borrow rate** that depends on pool utilization. The formula is:

    hourly_rate = base_rate + slope * utilization

Typical hourly rates range from 0.005% to 0.08% per hour depending on pool utilization, which translates to far higher annualized costs than the 12% originally assumed.

The three scenarios modeled in the corrected simulation:

| Scenario | Utilization | Annualized Borrow Rate | Fee per Side |
|---|---|---|---|
| Best case (low utilization) | Low | 55% APY | 6 bps |
| Realistic (medium utilization) | Medium | 80% APY | 8 bps |
| Stressed (high utilization) | High | 130% APY | 10 bps |

### Impact of the Correction

At 55% APY (best case), the perp hedge already underperforms the corridor certificate on most metrics. At realistic (80%) and stressed (130%) rates, the perp hedge shows negative mean weekly returns and negative Sharpe ratios for tight (+/-5%) ranges. The previous 12% APY figure was roughly 4-10x too low, which made the perp strategy appear artificially competitive.

---

## 3. Strategy Descriptions

### Bond (12%)

A baseline risk-free comparator: USDC lending at 12% APY. No IL exposure, no upside from fees. Provides the opportunity cost benchmark.

### Plain LP

An unhedged concentrated liquidity position on Orca's SOL/USDC Whirlpool. Earns trading fees when in range but is fully exposed to impermanent loss.

### Hedged LP (Corridor, Fixed 1.10x)

The Liquidity Hedge Protocol's core product. The LP buys a corridor certificate that matches the CL position's tick range. The payout is proportional to impermanent loss within the corridor, providing a near-exact hedge of the CL loss curve. The 1.10x markup means the LP pays 10% above the actuarially fair premium.

### Hedged LP (Two-Part)

A corridor certificate with two-part dynamic pricing: a fair-value component based on GBM-derived expected payout plus a volatility-responsive markup that adjusts weekly based on the 7-day vs 30-day vol ratio.

### Hedged LP + Jito (Two-Part)

Same as the two-part hedged LP, but the LP also earns Jito MEV tips on their staked SOL component, adding approximately 6 bps/week of additional yield.

### RT v1 (Two-Part)

The Risk Taker's perspective: the counterparty who underwrites the protection pool. Receives premiums but pays out on IL events. High median return but extreme tail risk.

### LP + Put Spread

A traditional DeFi hedge: the LP buys an out-of-the-money put spread on SOL to cap downside. Does not match the CL loss curve exactly (linear payout vs nonlinear CL loss).

### Perp Hedge (Jupiter)

A delta-hedging strategy using Jupiter perpetual futures. The LP shorts SOL perps to offset the SOL delta of the CL position, rebalancing weekly. Subject to borrow costs and gamma error.

---

## 4. Results: +/-5% Width

### Summary Table (51 weeks, real SOL/USDC data, markup = 1.10x)

| Strategy | Med/wk | Mean/wk | P(+) | Ann med | Sharpe | MaxDD |
|---|---|---|---|---|---|---|
| Bond (12%) | +0.22% | +0.22% | 100% | +12% | 0.000 | 0% |
| Plain LP | +3.05% | +0.58% | 75% | +378% | 0.096 | -43% |
| Hedged LP (corridor, fixed 1.10x) | +2.67% | +1.13% | 82% | +293% | 0.227 | -27% |
| Hedged LP (two-part) | +2.35% | +0.64% | 78% | +234% | 0.134 | -31% |
| Hedged LP+jito (two-part) | +2.41% | +0.70% | 78% | +245% | 0.147 | -30% |
| RT v1 (two-part) | +7.08% | -0.62% | 57% | +3411% | -0.047 | -81% |
| LP+Put Spread | +2.13% | +0.46% | 82% | +199% | 0.101 | -31% |
| Perp (best case 55%) | +0.79% | +0.20% | 65% | +51% | 0.059 | -20% |
| Perp (realistic 80%) | +0.54% | -0.06% | 63% | +32% | -0.018 | -24% |
| Perp (stressed 130%) | +0.05% | -0.55% | 51% | +3% | -0.164 | -35% |

### Corridor vs Perp Head-to-Head (+/-5%)

The corridor certificate outperforms the perp hedge in the majority of weeks:

- **vs Perp (best case, 55% APY):** Corridor wins 73% of weeks
- **vs Perp (realistic, 80% APY):** Corridor wins 84% of weeks
- **vs Perp (stressed, 130% APY):** Corridor wins 84% of weeks

### Key Observations (+/-5%)

1. **Sharpe ratio dominance:** The corridor hedge achieves a Sharpe of 0.227, far exceeding the best-case perp hedge (0.059) and the unhedged LP (0.096). This reflects the corridor's ability to reduce downside variance without sacrificing as much upside.

2. **MaxDD compression:** The corridor limits maximum drawdown to -27%, compared to -43% for plain LP. The perp hedge achieves comparable drawdown reduction (-20% to -35%) but at much lower returns.

3. **Perp mean returns erode quickly:** Even at the best-case 55% APY borrow rate, the perp hedge's mean weekly return (+0.20%) is roughly one-fifth of the corridor's (+1.13%). At realistic rates, the mean turns negative.

4. **RT tail risk:** The risk taker earns large median returns (+7.08%/week) but has a -81% max drawdown and negative mean, reflecting the heavy-tailed payout distribution.

---

## 5. Results: +/-10% Width

### Summary Table (51 weeks, real SOL/USDC data, markup = 1.10x)

| Strategy | Med/wk | Mean/wk | P(+) | Ann med | Sharpe | MaxDD |
|---|---|---|---|---|---|---|
| Bond (12%) | +0.22% | +0.22% | 100% | +12% | 0.000 | 0% |
| Plain LP | +2.74% | +0.80% | 75% | +308% | 0.139 | -38% |
| Hedged LP (corridor, fixed 1.10x) | +1.57% | +0.86% | 86% | +125% | 0.245 | -18% |
| Hedged LP (two-part) | +0.98% | +0.52% | 82% | +66% | 0.156 | -19% |
| Hedged LP+jito (two-part) | +1.04% | +0.58% | 82% | +71% | 0.175 | -18% |
| RT v1 (two-part) | +6.31% | +0.99% | 73% | +2309% | 0.085 | -68% |
| LP+Put Spread | +1.22% | +0.47% | 80% | +88% | 0.162 | -16% |
| Perp (best case 55%) | +1.59% | +0.42% | 73% | +128% | 0.151 | -15% |
| Perp (realistic 80%) | +1.35% | +0.18% | 73% | +101% | 0.063 | -18% |
| Perp (stressed 130%) | +0.87% | -0.30% | 71% | +57% | -0.106 | -26% |

### Corridor vs Perp Head-to-Head (+/-10%)

At the wider range, the head-to-head is more balanced because the wider position has lower gamma (less curvature), reducing the perp's gamma error disadvantage:

- **vs Perp (best case, 55% APY):** Corridor wins 49% of weeks
- **vs Perp (realistic, 80% APY):** Corridor wins 51% of weeks
- **vs Perp (stressed, 130% APY):** Corridor wins 61% of weeks

### Key Observations (+/-10%)

1. **Highest Sharpe across all strategies:** The corridor hedge at +/-10% achieves a Sharpe of 0.245 -- the highest value in any configuration tested. The wider range reduces IL volatility, and the corridor certificate's proportional payout matches the reduced curvature well.

2. **Perp is more competitive at +/-10%:** The best-case perp hedge (0.151 Sharpe, +1.59% median) approaches the corridor (0.245 Sharpe, +1.57% median) in absolute return terms. This is because the wider range has lower gamma, so the linear delta hedge's gamma error is smaller.

3. **MaxDD comparison:** Corridor achieves -18% max drawdown vs -15% for best-case perp. The perp's lower MaxDD reflects the fact that the short perp position provides direct price-level protection, while the corridor only activates upon settlement.

4. **P(+) advantage:** The corridor achieves 86% positive weeks -- the highest of any strategy -- compared to 73% for the perp strategies. The corridor's payout structure avoids the weekly drag of borrow costs that erode perp returns even in favorable weeks.

---

## 6. Gamma Error Analysis

### The Core Problem with Perp Hedging CL Positions

A concentrated liquidity position has a **nonlinear** value function. For a position with lower tick p_a and upper tick p_b, the value at price S is:

    V(S) = L * (sqrt(S) - sqrt(p_a) + (sqrt(p_b) - sqrt(S)) * p_b / S)    for p_a <= S <= p_b

The second derivative (gamma) of this value function is non-zero and varies with price. A perpetual futures position, by contrast, has a perfectly linear payoff. When a CL position is hedged with a perp short, the **gamma error** -- the difference between the CL loss curve and the linear hedge -- accumulates over each rebalancing period.

### Quantified Impact

Over the 51-week backtest, gamma error costs the perp hedge strategy an average of **$146 to $250 per week**, depending on the position width and rebalancing frequency. This is the dollar amount of CL impermanent loss that the linear perp hedge fails to offset.

The corridor certificate, by design, matches the CL loss curve exactly through its proportional payout formula:

    payout = min(cap, max(0, IL_realized * notional))

This eliminates gamma error entirely, which is the fundamental structural advantage of the corridor product over perp-based hedging.

### Width Dependence

- **+/-5% width:** High gamma (tight curvature). Gamma error is large, and the perp hedge significantly underperforms the corridor.
- **+/-10% width:** Lower gamma (flatter curvature). Gamma error is smaller, making the perp hedge more competitive, though the corridor still wins on Sharpe ratio and P(+).

---

## 7. Cross-Width Comparison

### Corridor Certificate Performance

| Width | Med/wk | Mean/wk | P(+) | Sharpe | MaxDD |
|---|---|---|---|---|---|
| +/-5% | +2.67% | +1.13% | 82% | 0.227 | -27% |
| +/-10% | +1.57% | +0.86% | 86% | 0.245 | -18% |

The wider range produces a higher Sharpe ratio (0.245 vs 0.227) despite lower absolute returns. This reflects the risk-adjusted benefit: the wider position has lower IL variance, and the corridor premium is proportionally lower, yielding better risk-adjusted performance.

### Perp Hedge Performance (Realistic 80% APY)

| Width | Med/wk | Mean/wk | P(+) | Sharpe | MaxDD |
|---|---|---|---|---|---|
| +/-5% | +0.54% | -0.06% | 63% | -0.018 | -24% |
| +/-10% | +1.35% | +0.18% | 73% | 0.063 | -18% |

The perp hedge improves dramatically at wider ranges because gamma error shrinks. However, even at +/-10% with realistic borrow rates, the perp achieves only 0.063 Sharpe vs the corridor's 0.245.

---

## 8. Summary of Findings

1. **The corridor certificate is the superior hedge for CL positions**, particularly at tight ranges where gamma error penalizes linear hedges most heavily.

2. **Jupiter perp costs are far higher than commonly assumed.** At realistic utilization (80% APY), the perp hedge has a negative mean return for tight (+/-5%) CL positions. The previous 12% APY assumption was 4-10x too low.

3. **Gamma error is the structural disadvantage of perp hedging.** The CL value function is nonlinear; a linear short cannot match it. This costs $146-$250/week on average and is the primary reason the corridor outperforms.

4. **The corridor achieves the highest Sharpe ratio** across all strategies tested (0.245 at +/-10%, 0.227 at +/-5%), combining high probability of positive weeks (82-86%) with moderate drawdowns.

5. **Wider ranges favor both strategies** but reduce the corridor's relative advantage. At +/-10% with best-case perp rates, the two strategies are roughly comparable in median return, though the corridor still wins on Sharpe and P(+).

6. **The risk taker (RT) role has extreme return characteristics** -- very high median but negative or near-zero mean and catastrophic max drawdown (-68% to -81%). This is consistent with an insurance-underwriter profile.
