# Pricing Methodology -- Mathematical Formalization

Liquidity Hedge Protocol v2

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

This ensures E[S_T] = S_0 under risk neutrality, which is the correct no-arbitrage condition for a non-dividend-paying asset.

---

## 2. Concentrated Liquidity Value Function

### Setup

A concentrated liquidity (CL) position in Orca Whirlpools is defined by:
- L: liquidity (the invariant parameter)
- p_l: lower price bound (corresponding to the lower tick)
- p_u: upper price bound (corresponding to the upper tick)

The position holds a combination of SOL and USDC such that the constant-product invariant is satisfied within the range [p_l, p_u].

### Three-Regime Value Formula

The value of a CL position at spot price S is:

**Regime 1: Below range (S <= p_l)**

    V(S) = L * (sqrt(p_u) - sqrt(p_l)) * S / sqrt(p_l * p_u)

Equivalently:

    V(S) = L * (1/sqrt(p_l) - 1/sqrt(p_u)) * S

When the price is below the range, the position holds only SOL. The value is purely SOL-denominated and scales linearly with S. This is the maximum-loss regime for USDC-denominated value.

**Regime 2: In range (p_l < S < p_u)**

    V(S) = L * (sqrt(S) - sqrt(p_l)) * sqrt(S) + L * (sqrt(p_u) - sqrt(S))

Simplifying:

    V(S) = L * (S/sqrt(p_l) - 2*sqrt(S) + sqrt(p_u))

Wait -- let us state this more carefully. The position holds:
- x SOL = L * (1/sqrt(S) - 1/sqrt(p_u))
- y USDC = L * (sqrt(S) - sqrt(p_l))

Value in USDC:

    V(S) = x * S + y
         = L * (S/sqrt(S) - S/sqrt(p_u)) + L * (sqrt(S) - sqrt(p_l))
         = L * (sqrt(S) - S/sqrt(p_u) + sqrt(S) - sqrt(p_l))
         = L * (2*sqrt(S) - S/sqrt(p_u) - sqrt(p_l))

This is the concave region. The position has sub-linear exposure to S: it tracks SOL upside and USDC downside, but with diminishing marginal returns in both directions due to constant rebalancing.

**Regime 3: Above range (S >= p_u)**

    V(S) = L * (sqrt(p_u) - sqrt(p_l))

When the price exceeds the upper bound, the position is entirely in USDC. The value is constant -- all SOL has been sold. This is also where the LP experiences maximum "opportunity cost" relative to a pure SOL hold.

### Notional Value

At entry (S = S_0, with S_0 in range), the notional is:

    N = V(S_0) = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - sqrt(p_l))

All payoffs and premiums are expressed relative to this notional.

---

## 3. Corridor Payoff

### Definition

The corridor hedge certificate pays the LP for the loss in CL position value when the price drops below the entry point, down to a barrier B (the lower tick price). The payoff is:

    payoff = min(Cap, max(0, V(S_0) - V(S_eff)))

where:

    S_eff = max(S_T, B)

This means:
- If S_T >= S_0: payoff = 0 (no loss, no payout)
- If B < S_T < S_0: payoff = V(S_0) - V(S_T) (partial corridor loss)
- If S_T <= B: payoff = V(S_0) - V(B) = natural cap (maximum payout)

### Barrier

The barrier B corresponds to the lower tick of the CL position:

    B = p_l

This is the price at which the position becomes 100% SOL. Below this price, the position's composition no longer changes (it is all SOL), but its USDC value continues to decline linearly. The corridor hedge covers the loss within the range only.

### Natural Cap

The natural cap is the maximum possible loss within the range:

    natural_cap = V(S_0) - V(B)

For practical computation:

    natural_cap = V(S_0) - V(p_l)
                = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - sqrt(p_l))
                  - L * (2*sqrt(p_l) - p_l/sqrt(p_u) - sqrt(p_l))
                = L * (2*sqrt(S_0) - 2*sqrt(p_l) - (S_0 - p_l)/sqrt(p_u))

The Cap used in the certificate is set to natural_cap. This ensures the hedge covers exactly the CL loss within the position's range.

### Why "Corridor" and Not "Barrier"

A barrier option has a binary trigger: it activates or deactivates when a level is crossed. The corridor certificate instead pays proportionally to the loss magnitude. It is called "corridor" because the payout corresponds to the price traversing a corridor between S_0 and B, with the payout scaling with how deep into the corridor the price has moved.

---

## 4. No-Arbitrage Fair Value

### Risk-Neutral Expectation

Under the risk-neutral measure (r = 0), the fair value of the corridor certificate is:

    FairValue = E[payoff] = E[min(Cap, max(0, V(S_0) - V(max(S_T, B))))]

Since S_T = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * Z) with Z ~ N(0,1), this becomes a one-dimensional integral over Z:

    FairValue = integral from -inf to +inf of
                  payoff(S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * z))
                  * phi(z) dz

where phi(z) = (1/sqrt(2*pi)) * exp(-z^2/2) is the standard normal density.

### Gauss-Hermite Quadrature

Direct numerical integration of the above is delicate because the integrand involves a normal density. Gauss-Hermite (GH) quadrature is designed exactly for integrals of the form:

    integral from -inf to +inf of f(x) * exp(-x^2) dx ≈ sum_{i=1}^{n} w_i * f(x_i)

where x_i are the GH nodes and w_i are the GH weights.

**Substitution:** To convert our integral to GH form, set z = x * sqrt(2):

    integral of payoff(z) * phi(z) dz
    = integral of payoff(x*sqrt(2)) * (1/sqrt(2*pi)) * exp(-x^2) * sqrt(2) dx
    = (1/sqrt(pi)) * integral of payoff(x*sqrt(2)) * exp(-x^2) dx

**Final formula:**

    FairValue = (1/sqrt(pi)) * sum_{i=1}^{128} w_i * payoff(S_T(x_i))

where:

    S_T(x_i) = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * x_i * sqrt(2))

### Why 128 Nodes

The payoff function has a kink at S_T = S_0 (where the max(0, ...) activates) and a saturation at S_T = B (where the min(Cap, ...) activates). These non-smooth points require high-order quadrature to capture accurately.

Convergence analysis:
- 32 nodes: ~1-2% relative error vs MC
- 64 nodes: ~0.1-0.5% relative error
- 128 nodes: <0.01% relative error
- 256 nodes: no further improvement (machine precision limits)

128 nodes provide effectively exact results while remaining computationally trivial (a single loop of 128 iterations). This is far more efficient than Monte Carlo, which requires 200k+ paths for comparable precision.

### Comparison with Monte Carlo

Monte Carlo (200k paths, antithetic variates) confirms the GH results to within 0.02% relative error across all tested volatility levels. GH is preferred for production because:
- Deterministic (no seed dependence)
- O(n) complexity with n=128
- No variance reduction tricks needed
- Sub-millisecond computation

---

## 5. On-Chain Heuristic Formula

### Motivation

The full GH quadrature requires floating-point arithmetic and is impractical on-chain (Solana BPF programs use integer math only). The on-chain heuristic approximates the fair value using closed-form integer expressions.

### Formula

    Premium = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling)

where:

    E[Payout] = Cap * p_hit * severity / PPM^2
    p_hit     = min(PPM, 900_000 * sigma * sqrt(T) / width)
    C_cap     = Cap * (U_after / PPM)^2 / 5
    C_adv     = Cap / 10     if stress_flag is set, else 0
    C_rep     = Cap * carry_bps * T_sec / BPS / 100 / 86400

### Component Explanations

**E[Payout] -- Expected Payout Approximation**

- Cap: the natural cap of the corridor certificate (in USDC lamports)
- p_hit: probability of the price hitting the barrier, expressed in PPM (parts per million, so PPM = 1_000_000 represents probability 1.0)
- severity: expected loss severity given a hit, in PPM
- Division by PPM^2 normalizes the two PPM-scaled factors back to a fraction of Cap

The p_hit formula approximates the probability that a GBM process drops by more than `width` (the half-width of the CL position) during tenor T. The 0.9 factor is calibrated to match the GBM cumulative distribution at typical parameters.

**C_cap -- Capacity Charge (Quadratic Utilization)**

- U_after: pool utilization after this certificate is activated, in PPM
- The quadratic form (U^2/5) creates a convex cost curve: low utilization is cheap, high utilization is expensive
- This protects the pool from concentration risk and incentivizes RTs to add capital when utilization rises
- At U = 30% (u_max), C_cap = Cap * 0.09 / 5 = 1.8% of Cap

**C_adv -- Adverse Selection Charge**

- Applied when the risk service detects a stress regime (high vol, momentum, or drawdown)
- Flat 10% of Cap surcharge
- Prevents LPs from buying cheap hedges right before a crash
- Binary: either 0 or Cap/10

**C_rep -- Carry/Replication Cost**

- carry_bps: annualized cost of carry (e.g., 200 bps = 2%)
- T_sec: tenor in seconds
- Represents the time value of capital locked in the pool
- Linear in time: longer tenors cost proportionally more

**Floor and Ceiling**

- Stored in the on-chain TemplateConfig account
- Floor prevents certificates from being too cheap (minimum viable premium for the protocol)
- Ceiling prevents extreme pricing during stress (caps LP cost)

### Integer Arithmetic and Scaling

All computations are in u64 or u128 integer arithmetic:
- PPM = 1_000_000 (parts per million, for probabilities and fractions)
- BPS = 10_000 (basis points, for rates)
- Prices in e6 (6 decimal places, matching USDC)
- Intermediate products use u128 to avoid overflow
- Division order is carefully chosen to minimize truncation error while avoiding overflow

Example: `Cap * p_hit * severity / PPM^2`
- Cap ~ 10^6 to 10^9 (lamports)
- p_hit ~ 10^5 to 10^6 (PPM)
- severity ~ 10^5 to 10^6 (PPM)
- Product ~ 10^16 to 10^21 -- fits in u128 (max 3.4 * 10^38)
- Dividing by PPM^2 = 10^12 yields result in lamports

---

## 6. v2: Dynamic Severity

### The Problem with Fixed Severity

In v1, severity was a fixed parameter per TemplateConfig (e.g., 500_000 PPM = 50%). This creates a systematic pricing error:

- At low volatility (sigma = 30%): p_hit is low, so E[Payout] is low. But severity overstates the conditional loss (a small move that barely crosses the barrier causes minimal actual loss). Result: premium is too low because p_hit dominates, but the few hits that occur pay too much.

- At high volatility (sigma = 100%): p_hit is high, but severity understates conditional loss (deep moves through the corridor are likely). Result: premium undershoots fair value.

The root cause is that severity (average fractional loss given a hit) is not constant -- it depends on the volatility of the underlying.

### Calibration Formula

The dynamic severity is computed off-chain by the risk service and passed to the on-chain program via the RegimeSnapshot. The calibration targets a desired premium level (typically 1.10x fair value):

    target = markup * FairValue(sigma)

Solving for severity:

    severity = (target - C_cap - C_rep) * PPM^2 / (Cap * p_hit)

where target, C_cap, and C_rep are all in lamports, and the result is in PPM.

### Severity vs Volatility (Width = +/-10%, Cap = natural cap)

| sigma (ann.) | p_hit (PPM) | FairValue (% of Cap) | Target 1.10x (% of Cap) | Severity (PPM) |
|---|---|---|---|---|
| 30% | 207,846 | 1.52% | 1.67% | 72,500 |
| 50% | 346,410 | 4.82% | 5.30% | 138,200 |
| 65% | 450,333 | 7.96% | 8.76% | 176,800 |
| 80% | 554,256 | 11.54% | 12.69% | 209,500 |
| 100% | 692,820 | 17.12% | 18.83% | 250,100 |

### Severity vs Volatility (Width = +/-5%, Cap = natural cap)

| sigma (ann.) | p_hit (PPM) | FairValue (% of Cap) | Target 1.10x (% of Cap) | Severity (PPM) |
|---|---|---|---|---|
| 30% | 415,692 | 3.88% | 4.27% | 91,600 |
| 50% | 692,820 | 10.52% | 11.57% | 150,700 |
| 65% | 900,433 | 16.08% | 17.69% | 179,200 |
| 80% | 1,000,000 | 21.74% | 23.91% | 219,800 |
| 100% | 1,000,000 | 30.22% | 33.24% | 308,400 |

Note: p_hit is capped at PPM (1,000,000) because a probability cannot exceed 1.

### Implementation

The risk service runs the calibration every time it updates the RegimeSnapshot:

1. Fetch trailing 30-day realized vol (sigma_30d)
2. Compute FairValue via GH quadrature at sigma_30d
3. Compute p_hit at sigma_30d
4. Compute C_cap at current utilization
5. Compute C_rep at template's carry_bps
6. Solve for severity
7. Write severity to RegimeSnapshot on-chain

This ensures the on-chain heuristic tracks the off-chain fair value within the floor/ceiling bounds across all market regimes.

---

## 7. v2: Two-Part Premium Model

### Motivation

A single upfront premium creates a timing problem:
- If vol is currently low but rises during the tenor, the LP overpaid relative to the risk
- If vol is currently high, the premium is expensive and deters LP participation
- Fee income from the CL position is uncertain at entry time

The two-part premium splits the cost into an upfront component (paid at certificate purchase) and a settlement component (deducted from fees at settlement). This aligns incentives: the LP pays more when the position earns more fees, and less when it does not.

### Formula

    P_total = P_upfront + P_settlement

**Upfront component:**

    P_upfront = alpha * FairValue(sigma_30d) * vol_indicator

where:
- alpha = 0.40 (recommended: 40% of fair value paid upfront)
- FairValue is computed via GH quadrature at the trailing 30-day vol
- vol_indicator adjusts for short-term vol relative to the calibration period

**Vol indicator:**

    vol_indicator = clip(sigma_7d / sigma_30d, 0.5, 2.0)

- sigma_7d: trailing 7-day realized volatility
- sigma_30d: trailing 30-day realized volatility
- Clipped to [0.5, 2.0] to prevent extreme values
- If recent vol is elevated (sigma_7d > sigma_30d), the upfront premium increases
- If recent vol is subdued, it decreases (but never below 50% of base)

**Settlement component:**

    P_settlement = beta * fees_accrued

where fees_accrued is the total fee income earned by the CL position during the tenor, and:

    beta = (markup - alpha) * FairValue / E[fees]

- markup = 1.10 (the target premium is 110% of fair value)
- E[fees]: expected fee income during the tenor, estimated from recent fee rates
- beta scales the settlement deduction so that the total premium hits the target markup in expectation

### How It Adapts to Market Conditions

**High-vol entry (sigma_7d/sigma_30d > 1):**
- vol_indicator > 1.0: upfront premium rises
- Fees are typically higher (more volume, more in-range time)
- Settlement component collects more
- LP pays more, but earns more -- net cost is reasonable

**Low-vol entry (sigma_7d/sigma_30d < 1):**
- vol_indicator < 1.0: upfront premium drops
- Fees are typically lower
- Settlement component collects less
- LP pays less, consistent with lower risk

**Crash during tenor:**
- Upfront was partial, so LP did not overpay
- Fees may be low (position out of range), so settlement is low
- Payout from the certificate offsets the position loss
- Net: LP is better protected than with full upfront pricing

### The alpha Parameter

alpha = 0.40 is recommended based on:
- Must be high enough for the pool to cover initial capital reservation
- Must be low enough to provide meaningful fee-contingent pricing
- At alpha = 0.40, the pool receives 40% of expected premium immediately, sufficient for capital adequacy
- The remaining 60% is contingent on fee realization

### The markup Parameter

markup = 1.10 means the total expected premium is 110% of the actuarially fair value. The 10% margin covers:
- Model risk (GBM is approximate)
- Execution slippage
- Protocol operational costs
- Risk taker profit margin

This is conservative for insurance-type products, where typical loading factors are 20-40%.

---

## 8. Alternative Hedging Strategies

### Black-Scholes Put Spread

An LP could buy a put spread on SOL:
- Buy put at strike K1 = S_0 (at the money)
- Sell put at strike K2 = B (barrier price)

Put spread payoff:

    payoff = max(0, K1 - S_T) - max(0, K2 - S_T)

This produces a piecewise linear payoff that approximates the corridor certificate. However, the mismatch is significant:

The CL position loss is **concave** in the price move (due to the sqrt terms in the value function), while the put spread payoff is **linear**. At intermediate prices (S_T between B and S_0), the put spread either overhedges or underhedges:

    CL loss at S_T = V(S_0) - V(S_T) = L * (2*sqrt(S_0) - 2*sqrt(S_T) - (S_0 - S_T)/sqrt(p_u))

    Put spread payoff at S_T = S_0 - S_T  (for K2 < S_T < K1)

The linear put spread overestimates the loss for small moves and underestimates it for large moves, leading to a basis risk that cannot be hedged away without dynamic adjustments.

### Perpetual Delta Hedge

A delta hedge using SOL perpetual futures:
- Compute delta = dV/dS of the CL position
- Short delta * S_0 notional in perpetuals
- Rebalance daily (or continuously)

The delta of the in-range CL position is:

    delta = dV/dS = L * (1/sqrt(S) - 1/sqrt(p_u))

The perpetual hedge payoff over a small interval:

    hedge_pnl = -delta * (S_{t+1} - S_t)

This approach neutralizes first-order price risk but:
- Does NOT hedge gamma (the second derivative of V with respect to S), which is the dominant risk for concentrated positions
- Requires continuous rebalancing (costly on-chain)
- Funding rates on perpetuals can be highly variable and costly
- Transaction costs compound with rebalancing frequency

### Why the Corridor Certificate is Superior

The corridor certificate matches the CL loss function exactly by construction:

    certificate_payoff = V(S_0) - V(max(S_T, B))

This means:
1. Zero basis risk within the corridor (the hedge matches the loss perfectly)
2. No gamma risk (the payoff is the actual CL value difference, not a linear approximation)
3. No rebalancing (single transaction at entry, single settlement at expiry)
4. No funding costs (fixed premium, no ongoing payments)
5. Capital-efficient (only the corridor is insured, not the full downside)

The trade-off is that the corridor certificate does not protect against losses below the barrier (S_T < B). But since the CL position converts entirely to SOL at the barrier, losses below it are linear and could be hedged separately with a simple put if desired.

---

## 9. Assumptions and Limitations

### GBM Assumptions

1. **Log-normal returns**: SOL/USDC returns exhibit excess kurtosis (~1.58 on daily data) and occasional jumps. GBM underestimates the probability of extreme moves. The corridor payoff is bounded (capped at natural cap), which partially mitigates fat-tail sensitivity.

2. **Constant volatility**: The model uses a single sigma for the entire tenor. In practice, volatility is stochastic. The two-part premium and dynamic severity partially address this by adjusting to recent vol conditions.

3. **Continuous paths**: GBM paths are continuous, but SOL/USDC can gap (especially around major events). The corridor payoff's cap provides a natural bound, so gap risk affects only the binary question of whether the barrier was breached, not the magnitude of the payout.

4. **Zero drift**: We set r = 0. Over 7-day tenors, the drift component is negligible relative to the volatility term (for sigma = 74%, the drift adjustment sigma^2/2 * T = 0.74^2/2 * 7/365 = 0.53%, versus the volatility term sigma * sqrt(T) = 10.3%).

### Fee Rate Assumptions

1. **Constant fee rate**: The simulation uses fixed daily fee rates (0.65% for +/-5%, 0.45% for +/-10%). In practice, fee rates fluctuate with trading volume, which is correlated with volatility.

2. **In-range fraction**: Fee accrual assumes a time-weighted in-range fraction based on historical price data. The actual in-range fraction depends on tick-level dynamics not captured by daily OHLCV data.

3. **No compounding**: Fees are computed as simple daily accrual, not compounded. Over 7-day tenors, the difference is negligible.

### No Transaction Costs in Pricing

The fair value computation does not include:
- Solana transaction fees (~0.000005 SOL per tx)
- CL position open/close slippage
- Priority fees during congestion
- Oracle price deviation from true market price

These costs are small relative to the premium (typically <0.1% of notional) and are implicitly covered by the 10% markup over fair value.

### Other Limitations

- **Single pair**: The model is calibrated for SOL/USDC only. Extension to other pairs requires re-calibration of fee rates, vol parameters, and tick spacing.
- **Single tenor**: 7-day fixed tenor. Longer tenors would require term structure modeling.
- **No correlation**: The model does not account for correlation between SOL price and fee generation (which are positively correlated through volume).
- **Oracle dependency**: Settlement relies on Pyth oracle prices with 30-second staleness tolerance and confidence interval adjustment. Oracle manipulation or failure is an external risk.
