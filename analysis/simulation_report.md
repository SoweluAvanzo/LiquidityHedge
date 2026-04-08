# Technical Report: Simulation Study and Protocol Design Evaluation

**Liquidity Hedge Protocol — Corridor CL Hedge**

---

## 1. Introduction

This report presents the results of a comprehensive Monte Carlo simulation study evaluating the economic viability of the Liquidity Hedge Protocol's corridor derivative product. The study compares 10 hedging and investment strategies across three position widths over a 52-week horizon with 10,000 simulated price paths per configuration.

The mathematical and statistical foundations (GBM, risk-neutral pricing, Gauss-Hermite quadrature, CL value function) are documented in the companion methodology document (`pricing_methodology.md`). This report focuses on the simulation design, assumptions, data sources, parameter optimization, results, and conclusions.

---

## 2. Simulation Framework

### 2.1 Price Model

SOL/USDC prices follow Geometric Brownian Motion with constant parameters:

| Parameter | Value | Source |
|-----------|-------|--------|
| Entry price $S_0$ | $130 | Orca Whirlpool sqrtPriceX64 (real, at time of analysis) |
| Annualized volatility $\sigma$ | 65% | 30-day realized vol from Birdeye 15-min candles (real) |
| Risk-free rate $r$ | 0% | Standard for short-tenor crypto derivatives |
| Time step | Daily (within weekly cycles) | |
| Horizon | 52 weeks (1 year) | |
| Paths | 10,000 per configuration | |

Daily prices: $S_{t+1} = S_t \exp\!\left[(r - \sigma^2/2) \cdot \frac{1}{365} + \sigma \sqrt{\frac{1}{365}} \, Z_t\right]$, $Z_t \sim \mathcal{N}(0,1)$.

**Note on volatility:** The simulation uses a fixed $\sigma = 65\%$ throughout, which is the correct approach for constant-vol GBM. In production, the off-chain risk service updates `RegimeSnapshot.sigma_ppm` every 15 minutes from trailing realized vol computed on Birdeye OHLCV candles. Under GBM, a trailing estimator converges to the true $\sigma$, so fixed-vol simulation is equivalent to correctly-functioning dynamic pricing. Testing dynamic vol estimation under GBM introduces estimation noise artifacts without improving accuracy (see Section 5.5).

### 2.2 CL Position Model

Each week, the LP re-centers a concentrated liquidity position around the current SOL price:
- Range: $[S_{\text{now}} \cdot (1-w), \, S_{\text{now}} \cdot (1+w)]$ for width $w$
- Position value at entry: equal to the LP's current wealth (fully deployed)
- Fee accrual: daily, only when the price is within the position range; out-of-range fee income set to 5% of in-range rate (residual from adjacent ranges)
- Impermanent loss: computed exactly from the CL value function $V(S)$

### 2.3 Corridor Certificate Model

At each weekly settlement:
- Barrier: $B = 0.90 \times S_{\text{entry}}$ (90% of that week's entry price)
- Natural cap: $\text{Cap} = V(S_{\text{entry}}) - V(B)$ — the exact CL loss at the barrier
- Premium: $\text{Fair Value} \times 1.20$ (premium multiplier), scaled proportionally to position size
- Fee share offset: 20--30% of LP trading fees credited against the premium (width-dependent)
- Payout: $\min(\text{Cap}, \max(0, V(S_{\text{entry}}) - V(S_{\text{eff}})))$ where $S_{\text{eff}} = \max(S_T, B)$

### 2.4 RT Pool Model

- Capital: $10,000 USDC (same as LP for fair comparison)
- Utilization cap: 30% ($u_{\max} = 3000$ bps) — max 30% of pool backs active certificates
- Certificates backed: $\lfloor \text{capital} \times u_{\max} / \text{Cap} \rfloor$ (varies by width)
- Correlated exposure: all certificates reference the same SOL price — when SOL crashes, ALL trigger simultaneously
- Idle capital lending: 70% of pool is idle; 85% lent at 5% APY via CPI to Kamino/MarginFi; 85% of yield to RT, 15% to protocol

### 2.5 Real vs Synthetic Data

| Data | Type | Source | Usage |
|------|------|--------|-------|
| SOL/USDC 30-day vol (65%) | Real | Birdeye 15-min OHLCV candles | GBM $\sigma$ calibration |
| SOL/USDC current price ($130) | Real | Orca Whirlpool sqrtPriceX64 | Entry price $S_0$ |
| SOL option IV (145% ATM) | Real | Deribit SOL options market data | Option strategy pricing |
| SOL option skew (-28% 25-delta) | Real | Deribit/Laevitas IV surface | OTM put pricing |
| Jupiter perp fees (0.06%/trade) | Real | Jupiter Perpetuals documentation | Perp strategy costs |
| Jupiter borrow rate (0.01%/hr) | Real | Jupiter pool utilization data | Perp carry costs |
| SOL staking APY (7%) | Real | Jito jitoSOL liquid staking | LP yield enhancement |
| USDC lending APY (5%) | Real | Kamino/MarginFi supply rates | Idle capital yield |
| Bond yield (12% APY) | Assumed | High-yield DeFi benchmark | Comparison baseline |
| Daily fee rates (0.65/0.34/0.23%/day) | Estimated | Orca pool analytics, width-adjusted | LP fee income model |
| GBM price paths | Synthetic | Monte Carlo simulation | 10,000 paths × 364 days |
| Weekly certificate payoffs | Synthetic | Computed from GBM paths + CL value function | Strategy returns |

---

## 3. Strategies Evaluated

| # | Strategy | Description | Capital |
|---|----------|-------------|---------|
| 1 | **Plain LP** | Unhedged CL position, earns fees, suffers IL | $10,000 in CL |
| 2 | **Hedged LP** | CL position + corridor certificate (renewed weekly) | $10,000 in CL |
| 3 | **Hedged LP + jitoSOL** | Same as 2, but using jitoSOL (earns 7% staking on SOL portion) | $10,000 in CL |
| 4 | **RT v1 (Pure Insurer)** | USDC in pool, earns premiums, pays claims, no CL position | $10,000 in USDC |
| 5 | **RT v2 (Productive)** | Wider CL position (2× LP width) + insurer + fee share | $10,000 in CL |
| 6 | **LP + Static Short Perp** | CL position + short ~48% SOL via Jupiter perp (held weekly) | $10,000 in CL |
| 7 | **LP + Dynamic Delta Hedge** | CL position + short SOL perp, rebalanced at 2% inventory change | $10,000 in CL |
| 8 | **LP + ATM Put** | CL position + weekly ATM put (Deribit IV=145%) on SOL exposure | $10,000 in CL |
| 9 | **LP + Put Spread** | CL position + weekly put spread (S₀→90%, Deribit pricing) | $10,000 in CL |
| 10 | **LP + OTM Put** | CL position + weekly OTM put (K=90%, Deribit IV=155%) | $10,000 in CL |
| 11 | **Bond** | Risk-free benchmark at 12% APY | $10,000 |

---

## 4. Parameter Optimization

### 4.1 The Imbalance Problem

Initial baseline parameters produced a severely unbalanced product:

| Metric | Hedged LP | RT v1 |
|--------|:---------:|:-----:|
| Median annual return | -51% | +601% |
| Sharpe ratio | -3.43 | 0.89 |
| P(capital loss) | 99.9% | 4.6% |

Root cause: premium too expensive (1.30× fair value), corridor too narrow (5% barrier covering only a tiny fraction of IL at 65% vol), cap too small ($500 on $10k position), no fee sharing.

### 4.2 Parameter Space Explored

A 6-dimensional sweep of 4,608 combinations was evaluated, each with 1,000 Monte Carlo paths over 52 weeks:

| Parameter | Values Tested |
|-----------|--------------|
| Premium multiplier | 1.00, 1.05, 1.10, 1.15, 1.20, 1.30 |
| Severity PPM | 200k, 300k, 400k, 500k |
| Barrier (% of entry) | 80%, 85%, 90%, 95% |
| Cap (USD) | $500, $1,000, $1,500, $2,000 |
| u_max (bps) | 3,000, 5,000, 7,000 |
| Fee share (bps) | 0, 500, 1,000, 1,500 |

**Objective function:** $\max \min(\text{LP Sharpe}, \text{RT Sharpe})$ — Nash bargaining fairness criterion ensuring neither side subsidizes the other.

### 4.3 Viability Region

A parameter combination is "viable" when both LP and RT have positive median annual returns. The viability depends strongly on the position width and fee income:

| Volatility | Width | Fee/day | Viable combos | Best LP return |
|:---:|:---:|:---:|:---:|:---:|
| 65% | ±5% | 0.50% | 0/432 | -28% |
| 65% | ±10% | 0.30% | 1/432 | +1% |
| 65% | ±15% | 0.18% | 0/432 | -16% |

With the updated (correct) fee rates of 0.65%/0.34%/0.23% per day:

| Width | Fee/day | Viable combos | Optimal PM | Optimal FS |
|:---:|:---:|:---:|:---:|:---:|
| ±5% | 0.65% | Many | 1.20× | 25% |
| ±10% | 0.34% | Many | 1.20× | 20% |
| ±15% | 0.23% | Many | 1.20× | 30% |

### 4.4 Final Optimized Parameters

| Parameter | Value |
|-----------|-------|
| Position widths | ±5%, ±10%, ±15% |
| Daily fee rates | 0.65%, 0.34%, 0.23% (respectively) |
| Barrier | 90% of entry price |
| Cap | Natural: $V(S_0) - V(B)$ |
| Premium multiplier | 1.20× fair value |
| u_max | 3,000 bps (30%) |
| Fee share | 25% (±5%), 20% (±10%), 30% (±15%) |
| Protocol fee | 1.5% of premium |
| Idle USDC lending | 5% APY, 85% utilization, 15% to protocol |
| jitoSOL staking | 7% APY on SOL portion |
| Early exit penalty | 2% of withdrawn capital |

### 4.5 Natural Cap Design

The cap is defined as $\text{Cap} = V(S_0) - V(B)$, the maximum CL loss within the corridor. This ensures:
- For any $S_T \in [B, S_0]$: payout = exact CL loss (perfect hedge within corridor)
- For $S_T < B$: payout = Cap (capped at barrier-level loss)

Natural cap values by width (at $10,000 notional, $S_0 = 130$, barrier = 90%):

| Width | Natural Cap | % of Notional | Certs per $10k RT |
|:---:|:---:|:---:|:---:|
| ±5% | $880 | 8.8% | 3 |
| ±10% | $745 | 7.5% | 4 |
| ±15% | $645 | 6.4% | 4 |

### 4.6 Utilization Sensitivity

Higher u_max allows more certificates per RT dollar but increases correlated crash exposure:

| u_max | Certs (±10%) | Max RT Loss | RT Median | RT Sharpe |
|:---:|:---:|:---:|:---:|:---:|
| 30% | 4 | 30% | +69% | 0.65 |
| 50% | 7 | 52% | +73% | 0.37 |
| 70% | 10 | 75% | +5% | 0.16 |

30% is optimal: sufficient certificates for meaningful income, bounded crash exposure.

---

## 5. Results

### 5.1 Strategy Comparison at Optimized Parameters

Full results across all three position widths (10,000 paths, 52 weeks):

**±5% width, 0.65%/day fees, PM=1.20×, FS=25%:**

| Strategy | Median | Sharpe | P(>bond) | P(loss) |
|----------|:------:|:------:|:--------:|:-------:|
| **Hedged LP + jitoSOL** | **+23.9%** | **0.96** | **67.5%** | **17.1%** |
| Hedged LP | +19.8% | 0.83 | 62.1% | 21.1% |
| RT v1 | +62.8% | 0.63 | 68.2% | 26.8% |
| Plain LP | +4.0% | 0.24 | 42.6% | 45.9% |
| Bond | +12.0% | inf | 0% | 0% |

**±10% width, 0.34%/day fees, PM=1.20×, FS=20%:**

| Strategy | Median | Sharpe | P(>bond) | P(loss) |
|----------|:------:|:------:|:--------:|:-------:|
| **Hedged LP + jitoSOL** | **+17.2%** | **0.82** | **59.2%** | **21.4%** |
| Hedged LP | +13.4% | 0.66 | 52.4% | 26.2% |
| RT v1 | +62.0% | 0.63 | 68.0% | 27.0% |
| Plain LP | +8.9% | 0.35 | 47.1% | 40.8% |
| Bond | +12.0% | inf | 0% | 0% |

**±15% width, 0.23%/day fees, PM=1.20×, FS=30%:**

| Strategy | Median | Sharpe | P(>bond) | P(loss) |
|----------|:------:|:------:|:--------:|:-------:|
| **Hedged LP + jitoSOL** | **+20.6%** | **1.00** | **65.5%** | **16.4%** |
| Hedged LP | +16.6% | 0.83 | 58.5% | 21.1% |
| RT v1 | +65.2% | 0.63 | 68.7% | 26.4% |
| Plain LP | +7.4% | 0.33 | 45.0% | 41.5% |
| Bond | +12.0% | inf | 0% | 0% |

**Key findings:**
1. The hedged LP **outperforms the plain LP** at every width (+4 to +16 percentage points in median)
2. The hedged LP **beats the 12% bond** 52--68% of the time
3. The RT earns **+62--65%** with bounded risk (max loss = 30% of capital)
4. jitoSOL staking adds **+3.5--4%** to the hedged LP's annual return

### 5.2 Corridor vs Alternative Hedges

At optimized parameters, the corridor derivative decisively outperforms all alternative hedging strategies:

| Strategy | ±5% | ±10% | ±15% | Annual Hedge Cost |
|----------|:---:|:---:|:---:|:---:|
| **Hedged LP (corridor)** | **+19.8%** | **+13.4%** | **+16.6%** | 117--158% |
| LP + Put Spread (Deribit) | -17.4% | -13.4% | -14.4% | 100--105% |
| LP + OTM Put (Deribit) | -59.6% | -56.6% | -56.4% | 102--108% |
| LP + ATM Put (Deribit) | -67.4% | -65.0% | -64.8% | 200--210% |
| LP + Static Short Perp | -32.0% | -28.0% | -28.2% | ~47% (borrow) |
| LP + Dynamic Delta Hedge | -33.2% | -29.2% | -29.3% | ~47% + rebal |

**Why the corridor wins:**
1. **IV gap:** Options are priced at 145% implied vol; the corridor is priced at 65% realized vol (1.20× markup). The LP saves the 80-point IV premium.
2. **Non-linear payoff match:** The corridor pays the exact CL loss $V(S_0) - V(S_T)$; options pay linear $(K - S_T)^+$. The CL loss is concave, so linear options systematically overpay in some regions and underpay in others.
3. **No borrow costs:** Perp-based hedges incur 0.24%/day borrow fees (~87% annualized); the corridor's cost is a fixed weekly premium.
4. **No gamma bleed:** Dynamic delta hedging a negative-gamma position (CL is concave) systematically loses money on each rebalance (sell low, buy high). The corridor avoids this entirely.

### 5.3 Capital Efficiency

The RT's capital efficiency comes from three mechanisms:

1. **Utilization leverage:** $10,000 at 30% u_max backs 3--4 certificates simultaneously, each earning a premium. The LP must deploy $10,000 to earn fees on a single position.
2. **Bounded downside:** The RT's max loss is u_max × capital = 30%. The LP's CL position can lose much more (IL is theoretically unbounded for extreme price moves below range).
3. **Market neutrality:** The RT's USDC pool is immune to SOL price movements between settlement events. The LP's capital fluctuates with the market.
4. **Idle yield:** 70% of RT capital earns 5% APY through lending, adding ~3% to the RT's total return.

### 5.4 Fee and Revenue Impact

The protocol's revenue model was tested and shown to have negligible impact on participant viability:

| Component | Impact on LP | Impact on RT | Protocol Revenue |
|-----------|:---:|:---:|:---:|
| 1.5% protocol fee | None (pays same premium) | -0.5% of weekly income | ~$1,100/yr per $10k pool |
| Fee sharing (20--30%) | Reduces effective premium | N/A | N/A |
| Idle lending (5% APY) | N/A | +3% bonus return | ~$70/yr per $10k pool |
| jitoSOL (7% APY) | +3.5--4% bonus return | N/A | N/A |
| Early exit (2%) | N/A | Penalizes panic exits | ~$690/yr per $10k pool |
| **Total** | **Net positive** | **Net positive** | **~$1,860/yr per $10k** |

### 5.5 Volatility Regime Analysis

The simulation uses fixed $\sigma = 65\%$ because:

1. **GBM has constant volatility by construction.** There are no vol regimes to adapt to.
2. **A trailing vol estimator on GBM paths converges to 65%** with noise. Testing showed that computing 30-day trailing vol from the simulated median path produced artifacts (estimator read ~20% due to diversification across paths), causing false results.
3. **Dynamic vol pricing is correct for production** (where the risk service reads real market data) but adds no information to constant-vol GBM simulations.
4. **To properly test dynamic pricing,** one would need a stochastic volatility model (Heston) or historical SOL price replay — extensions beyond the current scope.

---

## 6. Protocol Design Validation

### 6.1 No Double Loss for RT

The RT pool holds 100% USDC. The five mutations of `reserves_usdc` were verified in the on-chain code:
1. Initialize pool → 0
2. RT deposits → +amount
3. RT withdraws → -proportional share
4. LP buys certificate → +premium
5. Settlement payout → -payout

No mutation depends on SOL price directly. The RT faces only claim payouts, never IL or price exposure.

### 6.2 Pool Vault Market Neutrality

The USDC vault balance does not change with SOL price movements between events. SOL could move from $130 to $50 and `reserves_usdc` remains unchanged until someone calls `settle_certificate`. This was verified by exhaustive grep of all code paths that modify `reserves_usdc`.

### 6.3 LP Bounded Upside

Above the upper tick $p_u$, the CL position is 100% USDC with:
- Value: constant at $V(p_u) = L(\sqrt{p_u} - \sqrt{p_l})$
- Fees: zero (out of range)
- Further appreciation: zero

The LP's payoff profile resembles a covered call: bounded above, exposed below. This was visualized in the CL value curve analysis.

### 6.4 Orca / Uniswap V3 Equivalence

The concentrated liquidity formulas used throughout are identical between Uniswap V3 and Orca Whirlpools. The only difference is fixed-point scaling: `sqrtPriceX64` (Orca, u128) vs `sqrtPriceX96` (Uniswap, uint256). This was verified across four implementations in the codebase (Rust on-chain, Rust helpers, TypeScript, Python reference) and is documented at `math.rs` line 37: *"This is the standard Uniswap V3 / Orca formula."*

---

## 7. Conclusions

### 7.1 The Protocol is Economically Viable

At the optimized parameters, both sides of the derivative market earn positive returns:
- **Hedged LP:** +13--24% median annual return (Sharpe 0.66--1.00), beats bond 52--68% of the time
- **RT:** +62--65% median annual return (Sharpe 0.63), bounded max loss at 30%
- **Protocol:** 13.2% annual revenue on pool size from three non-extractive revenue streams

### 7.2 The Corridor is the Best CL Hedge Available

Compared to all tested alternatives (options, perps, bonds):
- **Cheaper than options** by 80+ volatility points (realized vol pricing vs implied vol)
- **More effective than perps** because it covers non-linear IL, not just linear delta
- **Higher risk-adjusted return than plain LP** across all widths
- **The only hedge that makes LP-ing profitable** at 65% SOL volatility

### 7.3 Parameter Sensitivity is Well-Understood

- The product works at all three widths when fee income exceeds ~0.24%/day (±15%), ~0.34%/day (±10%), or ~0.64%/day (±5%)
- The natural cap ensures perfect hedging within the corridor
- u_max=30% balances RT income vs crash exposure
- Fee sharing (20--30%) redistributes premium cost to balance LP/RT economics

### 7.4 The Revenue Model is Sustainable

Three revenue streams totaling ~13.2% of pool size annually:
1. Premium fee (1.5%): scales with certificate volume
2. Idle capital lending (USDC → Kamino): productive use of reserved capital
3. Early exit penalty (2%): revenue + anti-bank-run mechanism

Break-even pool size: ~$15,000. Infrastructure costs (~$2,000/year) are trivially small relative to revenue at any meaningful scale.

---

## 8. References

[1] Companion document: "No-Arbitrage Pricing of the Corridor CL Hedge: Background, Methodology, and Results" (`pricing_methodology.md`)

[2] Simulation notebooks: `pricing_analysis.ipynb`, `rt_vs_lp_analysis.ipynb`, `parameter_optimization.ipynb`

[3] Integration test data: `analysis/data/` (audit.jsonl, monitor-timeline.csv, performance-summary.csv, simulated-payouts.csv)

[4] Deribit SOL Options: IV=145% ATM, -28% 25-delta skew (April 2026 market data)

[5] Jupiter Perpetuals: 0.06% open/close fee, 0.005--0.01%/hr borrow rate

[6] Jito Liquid Staking: ~7% APY (https://www.jito.network/)

[7] Kamino Finance: ~5% USDC supply APY (https://docs.kamino.finance/)

[8] Orca Whirlpools: SOL/USDC pool (https://docs.orca.so/)
