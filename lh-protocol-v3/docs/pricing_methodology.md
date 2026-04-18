# Pricing Methodology -- Mathematical Formalization

Liquidity Hedge Protocol v3

---

## 1. Geometric Brownian Motion

### Stochastic Differential Equation

The SOL/USDC spot price S(t) is modeled under the risk-neutral measure as a Geometric Brownian Motion (GBM):

    dS = r * S * dt + sigma * S * dW

where:
- S is the spot price (SOL/USDC)
- r is the risk-free drift (set to 0 for crypto pricing)
- sigma is the annualized volatility
- dW is a standard Wiener process increment

### Ito's Lemma Derivation

Applying Ito's lemma to f(S) = ln(S):

    d(ln S) = (1/S) * dS - (1/2) * (1/S^2) * sigma^2 * S^2 * dt
            = (r - sigma^2/2) * dt + sigma * dW

Integrating from 0 to T:

    ln(S_T) - ln(S_0) = (r - sigma^2/2) * T + sigma * W_T

Since W_T ~ N(0, T), we can write W_T = sqrt(T) * Z where Z ~ N(0,1).

### Terminal Distribution

    S_T = S_0 * exp((r - sigma^2/2) * T + sigma * sqrt(T) * Z)

where Z ~ N(0,1). The terminal price is log-normally distributed:

    ln(S_T) ~ N(ln(S_0) + (r - sigma^2/2) * T,  sigma^2 * T)

For r = 0 (our default):

    S_T = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * Z)

This ensures E[S_T] = S_0 under risk neutrality.

---

## 2. Concentrated Liquidity Value Function

### Setup

A concentrated liquidity (CL) position in Orca Whirlpools is defined by:
- L: liquidity (the invariant parameter)
- p_l: lower price bound (lower tick)
- p_u: upper price bound (upper tick)

### Three-Regime Value Formula

**Below range (S <= p_l):**

    V(S) = L * (1/sqrt(p_l) - 1/sqrt(p_u)) * S

The position holds only SOL. Value scales linearly with S.

**In range (p_l < S < p_u):**

    V(S) = L * (2*sqrt(S) - S/sqrt(p_u) - sqrt(p_l))

The position holds a mix of SOL and USDC. Value is concave in S.

**Above range (S >= p_u):**

    V(S) = L * (sqrt(p_u) - sqrt(p_l))

The position is entirely USDC. Value is constant.

### Notional Value

At entry (S = S_0, in range):

    N = V(S_0) = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - sqrt(p_l))

---

## 3. Corridor Payoff

### Definition

The corridor certificate pays the LP for CL position value loss when price drops below entry, down to a barrier B:

    payoff = min(Cap, max(0, V(S_0) - V(S_eff)))

where:

    S_eff = max(S_T, B)

Three cases:
- S_T >= S_0: payoff = 0 (no loss)
- B < S_T < S_0: payoff = V(S_0) - V(S_T) (partial corridor loss)
- S_T <= B: payoff = V(S_0) - V(B) = natural cap (maximum payout)

### Barrier in v3

The barrier is derived from the template's barrierDepthBps parameter:

    B = S_0 * (1 - barrierDepthBps / 10000)

Default: barrierDepthBps = 1000, so B = S_0 * 0.90.

This decouples the barrier from the CL position width, allowing the protocol to offer different barrier depths for the same position range.

### Natural Cap

    natural_cap = V(S_0) - V(B)

For the in-range case:

    natural_cap = L * (2*sqrt(S_0) - 2*sqrt(B) - (S_0 - B)/sqrt(p_u))

### Cover-Ratio Scaled Payoff

In v3, the LP chooses a cover ratio c in [0.25, 1.00]:

    scaled_cap = natural_cap * c
    scaled_payoff = min(scaled_cap, max(0, V(S_0) - V(S_eff)))

Equivalently:

    scaled_payoff = full_corridor_payoff * c

The LP hedges fraction c of the corridor loss and retains fraction (1-c) as unhedged exposure.

---

## 4. No-Arbitrage Fair Value

### Risk-Neutral Expectation

    FairValue = E[min(Cap, max(0, V(S_0) - V(max(S_T, B))))]

Since Cap = natural_cap * c and the payoff is scaled by c:

    FairValue(c) = c * E[min(natural_cap, max(0, V(S_0) - V(max(S_T, B))))]
                 = c * FairValue(1)

The fair value scales linearly with coverRatio.

### Gauss-Hermite Quadrature

Using the substitution z = x * sqrt(2):

    FairValue = (1/sqrt(pi)) * sum_{i=1}^{128} w_i * payoff(S_T(x_i))

where:

    S_T(x_i) = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * x_i * sqrt(2))

128 nodes provide <0.01% relative error vs Monte Carlo, which is effectively exact for our purposes.

---

## 5. v3 Pricing Formula

### Fee-Split Premium Model

    Premium = FairValue * max(MarkupFloor, IV/RV) * CoverRatio - FeeSplitRate * E[WeeklyFees]

Where:
- FairValue: no-arbitrage expected corridor payout (128-node Gauss-Hermite quadrature)
- MarkupFloor: minimum markup (default 1.05, governance-configurable)
- IV/RV: implied volatility / realized volatility ratio (from Bybit/Binance, lower of two)
- CoverRatio: fraction of IL covered (default 1.00 = full coverage)
- FeeSplitRate: fraction of LP fees flowing to RT at settlement (default 0.10 = 10%)
- E[WeeklyFees]: expected weekly fee income = V0 * expectedDailyFee * 7
  PoC: fixed at 0.5%/day (calibratable)
  Production: trailing 1-week average from on-chain fee data

The fee discount reflects that the RT will receive FeeSplitRate% of actual fees at settlement.
This creates a lower upfront cost for the LP, funded by the RT's fee income stream.

Since FairValue already accounts for the cover ratio when computed on the scaled cap, the formula can also be expressed as:

    Premium = FairValue(scaledCap) * effectiveMarkup - feeSplitRate * E[WeeklyFees]

Both forms are equivalent because FairValue scales linearly with cap.

### Effective Markup

    effectiveMarkup = max(markupFloor, IV / RV)

Where:
- markupFloor = 1.05 (default, configurable per pool)
- IV = ATM implied volatility of SOL options (lower of Bybit and Binance)
- RV = trailing 30-day realized volatility from Birdeye OHLCV

**Why IV/RV?**

The IV/RV ratio measures the market's risk premium for SOL. When IV > RV, option market participants price in more risk than recent history suggests. This is directly analogous to the loading factor in insurance pricing: the protocol charges more when the market perceives elevated risk.

Typical values:
- Calm: IV/RV ~ 1.02-1.10 (market trusts recent vol)
- Elevated: IV/RV ~ 1.15-1.40 (market prices in risk increase)
- Stress: IV/RV ~ 1.50+ (market sees significant downside)

**Why the floor at 1.05?**

Even when IV/RV < 1.05 (rare: implies options are cheap relative to realized vol), the protocol maintains a minimum 5% loading. This covers:
- Model risk (GBM is approximate)
- Oracle risk (Pyth staleness, confidence intervals)
- Operational costs (transactions, risk service)
- Minimum RT margin

### Dual-Source IV

The protocol fetches ATM SOL implied volatility from two exchanges:

1. **Bybit:** GET https://api.bybit.com/v5/market/tickers?category=option&baseCoin=SOL
   - Field: markIv (decimal, e.g. 0.60 = 60%)

2. **Binance:** GET https://eapi.binance.com/eapi/v1/mark
   - Field: markIV (decimal, e.g. 0.60 = 60%)

The protocol picks the **lower** IV from the two sources. This is LP-friendly: a lower IV means a lower IV/RV ratio, which means a lower markup and cheaper premium for the LP. It also provides resilience: if one exchange has stale or manipulated quotes, the other serves as a check.

---

## 6. Settlement Cash Flows

### Fee-Split at Settlement

At settlement (end of 7-day tenor):

    LP receives: corridor_payout
    LP keeps:    fees * (1 - FeeSplitRate)     [LP's share of trading fees]
    LP paid:     premium                        [at purchase, already debited]

    RT receives: premium * (1 - protocolFee)   [upfront premium income]
               + fees * FeeSplitRate            [fee split income from LP]
               - corridor_payout               [claims paid to LP]

    Protocol:    premium * protocolFee          [1.5% of premium to treasury]

### RT Income Decomposition

    RT total weekly income = premium_income + fee_split_income - claims

Where:
  premium_income = premium * 0.985 (after 1.5% protocol fee)
  fee_split_income = actual_fees * fee_split_rate
  claims = corridor_payout * cover_ratio

The fee split provides income diversification:
- In good weeks (no claims): RT earns premium + fee split
- In bad weeks (claims > 0): fee split partially offsets the loss
- Fee split income is correlated with LP fee income, not with claims

### Consistency with Literature

The fee-split model extends the equilibrium frameworks in the LP pricing literature:

1. Khakhar & Chen (2208.03318): Fair value is computed from position PnL,
   independent of fees. The fee split is an economic mechanism layered on top.

2. Zhang et al. (2309.10129): PnL = Fee + LVR. The fee split allocates a
   portion of Fee to the RT, effectively sharing the fee income between
   the LP (who provides liquidity) and the RT (who underwrites the risk).

3. Hasbrouck, Rivera & Saleh: Equilibrium requires fees to compensate for LVR.
   The fee split ensures the RT participates in fee income, making the RT's
   return profile closer to that of an LP (fee income + risk exposure) rather
   than a pure insurance seller (premium income only).

4. Kroo et al.: Their profitability criterion APY >= f(sigma) applies to the LP's
   net fee income after the split: APY_net = APY * (1 - feeSplitRate).
   The LP's viability condition becomes: APY * (1 - feeSplitRate) >= f(sigma) + premium/V0.

### Numerical Example

Position: +/-7.5% SOL/USDC at S0=$82
V0 = $6,700, Natural cap = $374
Fee rate: 0.55%/day -> expected weekly fees = $258

Fair value: $135 (128-node GH quadrature at sigma=57%)
IV/RV ratio: 1.05 (from Bybit)
Cover ratio: 1.00

    Premium = $135 * max(1.05, 1.05) * 1.00 - 0.10 * $258
            = $141.75 - $25.80
            = $115.95

Good week (SOL +2%, no IL):
  LP: +$258 fees * 0.90 = +$232.20 kept, -$115.95 premium paid = +$116.25
  RT: +$115.95 * 0.985 = +$114.21 premium + $258 * 0.10 = +$25.80 fee split = +$140.01

Bad week (SOL -5%, corridor triggers, payout = $200):
  LP: +$100 fees * 0.90 = +$90.00 kept + $200 payout - $115.95 premium = +$174.05 (with payout)
  RT: +$114.21 premium + $100 * 0.10 = +$10.00 fee split - $200 claim = -$75.79

---

## 7. Derived Severity Formula

### Context

The on-chain heuristic uses a `severityPpm` parameter to approximate the fair value:

    E[Payout] = Cap * p_hit * severity / PPM^2

Severity represents the expected fractional loss given that the price hits the barrier. It is not constant: it varies with volatility.

### v3 Calibration Target

In v3, severity targets the **unloaded** fair value (markup = 1.0):

    heuristic(severity) = FairValue

The effectiveMarkup is applied multiplicatively after the heuristic computation. This separation means:
- Severity captures the risk model (how bad is a hit?)
- Markup captures the market loading (how much above fair value?)

### Calibration Formula

The heuristic is:

    H = E[Payout] + C_cap + C_adv + C_rep

We want H = FairValue. Since E[Payout] = Cap * p_hit * severity / PPM^2:

    severity = (FairValue - C_cap - C_adv - C_rep) * PPM^2 / (Cap * p_hit)

If the non-severity costs (C_cap + C_adv + C_rep) already exceed the fair value, severity is floored at 1 (the minimum meaningful value).

### Severity vs Volatility (Width = +/-10%, 7-day tenor)

| sigma (ann.) | p_hit (PPM) | FairValue (% of Cap) | Severity (PPM) |
|---|---|---|---|
| 30% | 207,846 | 1.52% | 65,900 |
| 50% | 346,410 | 4.82% | 125,600 |
| 65% | 450,333 | 7.96% | 160,700 |
| 80% | 554,256 | 11.54% | 190,400 |
| 100% | 692,820 | 17.12% | 227,400 |

Note: these values are lower than v2's because v3 severity targets fair value (1.0x), not markup * fair value (1.10x). The markup is applied separately.

### Implementation

The risk service runs calibration every time it updates the RegimeSnapshot:

1. Fetch trailing 30-day realized vol (sigma_30d) from Birdeye
2. Compute FairValue via GH quadrature at sigma_30d
3. Compute p_hit, C_cap, C_adv, C_rep at current pool state
4. Solve for severity using the formula above
5. Write severity to RegimeSnapshot on-chain

The weighted average across active templates uses 1/widthBps weighting. With a single +/-10% template in v3, this simplifies to direct calibration at widthBps = 1000.

---

## 8. On-Chain Heuristic (Integer Arithmetic)

### Formula

    Premium = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling) * effectiveMarkup_ppm / PPM

Where all intermediate computations use u64/u128 integer arithmetic:

    E[Payout] = Cap * p_hit * severity / PPM^2
    p_hit     = min(PPM, 900_000 * sigma * sqrt(T) / width)
    C_cap     = Cap * (U_after / PPM)^2 / 5
    C_adv     = Cap / 10     if stress_flag, else 0
    C_rep     = Cap * carry_bps * T_sec / BPS / 100 / 86400

The effectiveMarkup is stored in RegimeSnapshot as a PPM-scaled value:

    effectiveMarkup_ppm = max(markupFloor_ppm, ivRvRatio_ppm)

### Integer Scaling

- PPM = 1,000,000 (probabilities, fractions)
- BPS = 10,000 (rates)
- Prices in e6 (USDC decimals)
- Cap scaled as natural_cap * coverRatio before entering the formula
- effectiveMarkup_ppm: e.g. 1,050,000 for 1.05x
- Final division by PPM yields the premium in lamports

### Overflow Analysis

Maximum intermediate product:
- Cap ~ 10^9 (lamports, $1000 position)
- p_hit ~ 10^6
- severity ~ 10^6
- Product: 10^21 -- fits in u128 (max 3.4 * 10^38)
- After / PPM^2: result in lamports

Markup multiplication:
- Premium ~ 10^9 (post-clamp)
- effectiveMarkup_ppm ~ 2 * 10^6
- Product: 2 * 10^15 -- fits in u128
- After / PPM: result in lamports

---

## 9. Alternative Hedging Strategies (Updated for v3)

### Black-Scholes Put Spread

A put spread (buy put at K1 = S_0, sell put at K2 = B) produces a linear payoff that systematically mismatches the concave CL loss function. The corridor certificate eliminates this basis risk by matching V(S_0) - V(max(S_T, B)) exactly.

With v3 cover ratio, the LP can achieve similar economic exposure to a "reduced notional" put spread, but without the basis risk. At coverRatio = 0.50, the LP hedges 50% of the corridor, analogous to buying a put spread at 50% of the notional -- but with exact curve matching.

### Perpetual Futures Delta Hedge

v2 simulation results (unchanged, as v3 does not alter the hedge payoff mechanics):

**+/-10% width:**
- Corridor: 0.245 Sharpe, 86% P(+), -18% MaxDD
- Perp (realistic 80% APY): 0.063 Sharpe, 73% P(+), -18% MaxDD

The corridor wins on Sharpe (3.9x) and P(+) (86% vs 73%) while matching the perp on MaxDD. The key structural advantage is zero gamma error: the corridor payoff tracks the CL value function exactly, while the perp's linear hedge accumulates gamma error at every rebalancing.

### v3 Cover Ratio vs. Perp Sizing

An LP using perps can reduce exposure by shorting less delta. With v3 cover ratio, the LP achieves the same economic goal (partial hedge) but:
- No ongoing borrow costs (fixed premium)
- No gamma error (exact CL loss matching)
- No rebalancing (single transaction)
- Transparent cost (3-number formula)

---

## 10. Assumptions and Limitations

### GBM Assumptions (Same as v2)

1. **Log-normal returns:** SOL/USDC has excess kurtosis (~1.58 daily). GBM underestimates tail probabilities, but the corridor's capped payoff mitigates fat-tail sensitivity.

2. **Constant volatility:** The model uses a single sigma. The IV/RV-based markup partially compensates: when the market expects vol to change (high IV/RV), the premium increases.

3. **Zero drift:** Over 7-day tenors, drift is negligible (sigma^2/2 * T = 0.53% vs sigma*sqrt(T) = 10.3% at sigma = 74%).

### Cover Ratio Assumptions

1. **Linear scaling:** The fair value scales linearly with cover ratio. This is exact for the corridor payoff (which is cap-proportional) but approximate for the capital charge component (which depends on pool utilization, not just the individual certificate's cap).

2. **No adverse selection on cover ratio:** The protocol does not adjust pricing based on the LP's choice of cover ratio. An LP choosing coverRatio = 0.25 pays exactly 25% of the full-coverage premium. In theory, informed LPs might choose high cover ratios when they expect IL and low ratios otherwise. The 15-minute regime freshness constraint and IV/RV-based markup partially mitigate this.

### Fee Split Assumptions

1. **Fee observability:** The fee split requires knowing the LP's actual fee income during the tenor. In the off-chain emulator, this is passed as a parameter at settlement. On-chain, this would require an oracle or the LP to self-report (with potential manipulation concerns). A trustless on-chain implementation might require reading Orca position fee state directly.

2. **Expected daily fee stability:** The premium discount uses expectedDailyFee (default 0.5%/day) to estimate weekly fees. In production, this should be calibrated from trailing on-chain fee data. If actual fees deviate significantly from the estimate, the RT may over- or under-receive relative to the discount given.

3. **No compounding:** The fee split is computed on a per-certificate basis at settlement, not compounded across certificates.

### IV Data Assumptions

1. **SOL option liquidity:** SOL options on Bybit and Binance may have limited liquidity, leading to wide bid-ask spreads on IV quotes. The dual-source, take-lower approach mitigates this but does not eliminate it.

2. **ATM proxy:** The protocol uses ATM IV as a proxy for the relevant strike range. For deep OTM scenarios (price drops 10%+), skew-adjusted IV would be more appropriate. ATM IV is a conservative (low) estimate of OTM IV, so the markup is biased slightly low.

3. **Stale IV:** If both exchanges' IV data becomes stale, the effectiveMarkup falls back to markupFloor (1.05). The regime freshness check (15-minute max age) provides an additional safeguard.
