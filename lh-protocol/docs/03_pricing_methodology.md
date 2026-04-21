# 3. Pricing Methodology

## 3.1 Fair Value as Risk-Neutral Expectation

The fair value (FV) of the Liquidity Hedge certificate is the discounted risk-neutral expectation of the signed swap payoff. Since the tenor is short (7 days) and USDC is the numeraire, we neglect discounting and define:

```
FV = E^Q[PI(S_T)] = integral from 0 to infinity of PI(S_T) * f(S_T) dS_T
```

where `f(S_T)` is the risk-neutral density of `S_T` under GBM (Section 2.2.2) and `PI(S_T) = V(S_0) - V(clamp(S_T, p_l, p_u))` is the swap payoff (Definition 2.2).

**Sign of `FV`.** Even though the integrand is signed — positive for `S_T < S_0`, negative for `S_T > S_0` — the integral `FV = E_Q[V(S_0) - V(clamp(S_T, p_l, p_u))]` is **always non-negative**. This follows from Jensen's inequality applied to the concave function `V(clamp(·, p_l, p_u))`: under the risk-neutral measure (with `r = 0`, `E_Q[S_T] = S_0`),

```
E_Q[V(clamp(S_T, p_l, p_u))] <= V(E_Q[clamp(S_T, p_l, p_u)]) <= V(S_0),
```

so `FV >= 0`. Equality holds only in the degenerate limit `σ → 0`. The magnitude of `FV` is the **convexity adjustment** — the risk-neutral premium the LP pays for transferring the concavity of their position to the RT.

### 3.1.1 Put-Minus-Call-Spread Decomposition

By the identity `V(S_0) - V(clamp(S_T, p_l, p_u)) = [V(S_0) - V(max(S_T, p_l))]_+ - [V(min(S_T, p_u)) - V(S_0)]_+`, the swap FV decomposes as

```
FV_swap = FV_put_spread − FV_call_spread
```

where

```
FV_put_spread  = E_Q[min(Cap_down, max(0, V(S_0) − V(max(S_T, p_l))))]   (downside leg)
FV_call_spread = E_Q[min(Cap_up,   max(0, V(min(S_T, p_u)) − V(S_0)))]    (upside leg)
```

Both legs are non-negative, and by the concavity wedge of Proposition 2.1, `FV_put_spread > FV_call_spread`, so `FV_swap > 0`. The decomposition is useful for both intuition and pricing: each leg is a standard capped-put FV integral, and the swap FV is their difference.

Substituting the standard normal parameterization `z -> S_T(z) = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * z)`:

```
FV = integral from -inf to +inf of PI(S_T(z)) * phi(z) dz
```

where `phi(z) = exp(-z^2/2) / sqrt(2*pi)`.

This integral has no closed-form solution because `PI` involves the CL value function (a piecewise function with `sqrt` terms). We compute it numerically.

## 3.2 Numerical Integration

### 3.2.1 Composite Simpson's Rule

We evaluate the FV integral using composite Simpson's rule over a truncated domain `[-Z_max, Z_max]` with `Z_max = 6`. This truncation introduces negligible error: `P(|Z| > 6) < 2 * 10^{-9}`.

**Method.** Partition `[-Z_max, Z_max]` into `N` equal sub-intervals (N must be even) with step size `h = 2 * Z_max / N`. The nodes are `z_i = -Z_max + i * h` for `i = 0, 1, ..., N`.

The composite Simpson approximation is:

```
FV_N = (h/3) * [g(z_0) + 4*g(z_1) + 2*g(z_2) + 4*g(z_3) + ... + g(z_N)]
```

where the integrand is `g(z) = PI(S_T(z)) * phi(z)`.

The coefficients follow the pattern: 1, 4, 2, 4, 2, ..., 4, 2, 4, 1.

### 3.2.2 Implementation Parameters

The protocol uses `N = 200` sub-intervals, yielding 201 evaluation points. At each node `z_i`:

1. Compute the terminal price: `S_T = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * z_i)`
2. Evaluate the Liquidity Hedge payoff: `PI(S_T) = V(S_0) − V(clamp(S_T, p_l, p_u))` (signed)
3. Weight by the normal PDF: `g(z_i) = PI(S_T) * phi(z_i)`

### 3.2.3 Convergence Analysis

Simpson's rule has error `O(h^4)` for smooth integrands [12, 13]. The integrand `g(z) = PI(S_T(z)) * phi(z)` is:

- Continuous everywhere (Proposition 2.2(v))
- C^1 except at `z` values mapping to `S_T = p_l` and `S_T = p_u`, where `PI` has derivative discontinuities (the two clamp kinks)

At the kink points, Simpson's rule converges as `O(h^2)` locally. However, with `N = 200` and `h = 0.06`, the numerical error is below 0.01% relative to Monte Carlo estimates with 10^6 paths. This was verified empirically for `sigma in [0.30, 1.50]` and width `+/-10%`.

**Comparison with Gauss-Hermite quadrature.** Classical Gauss-Hermite (GH) quadrature with weight function `exp(-x^2)` is theoretically optimal for Gaussian integrals. However, GH nodes and weights require polynomial root-finding that becomes numerically unstable for `n > 60` due to overflow in Hermite polynomial evaluation. The composite Simpson approach is unconditionally stable for any `N` and achieves comparable accuracy at `N = 200`.

### 3.2.4 Alternative: Gauss-Hermite Transformation

The code names the FV function `computeGaussHermiteFV` because the integral structure matches the GH framework: an expectation over a Gaussian variable. The transformation from GH to Simpson is:

```
GH:      FV = (1/sqrt(pi)) * sum_{i=1}^{n} w_i * PI(S_T(x_i * sqrt(2)))
Simpson: FV = (h/3) * sum_{i=0}^{N} c_i * PI(S_T(z_i)) * phi(z_i)
```

Both compute the same integral; Simpson is preferred for its numerical stability.

## 3.3 The Canonical Premium Formula

### 3.3.1 Definition

**Definition 3.1** (Canonical Premium). The premium charged to the LP is:

```
Premium = max(P_floor, FV * m_vol - y * E[F])
```

where:

- `FV` = fair value of the signed Liquidity Hedge swap payoff (risk-neutral expectation, Section 3.1)
- `m_vol = max(markupFloor, IV/RV)` = volatility markup (Section 3.3.3)
- `y` = fee-split rate (e.g., 0.10 = 10%)
- `E[F]` = expected LP trading fees over the tenor
- `P_floor` = governance-set minimum premium

### 3.3.2 Derivation of Each Term

**Fair Value `FV`.** The risk-neutral expected payout, computed via numerical integration. This is the cost to the RT of providing the hedge under the GBM model.

**Volatility Markup `m_vol`.** The GBM model uses realized volatility (RV), but the true cost of bearing volatility risk is better captured by implied volatility (IV) from option markets. The ratio `IV/RV` -- the *variance risk premium* -- is typically > 1 because option sellers demand compensation for volatility uncertainty [14, 15].

```
m_vol = max(markupFloor, IV/RV)
```

The floor (default: 1.05) prevents underpricing during calm periods when IV may temporarily dip below RV. This ensures the RT earns at least a 5% markup over the actuarially fair price.

**Fee Discount `y * E[F]`.** The LP's trading fees provide an alternative revenue stream to the RT pool. At settlement, a fraction `y` of the LP's accrued fees is transferred to the RT. This future income reduces the upfront premium:

```
E[F] = notional * expectedDailyFee * tenorDays
y * E[F] = feeSplitRate * E[F]
```

For the default parameters: `notional = $30`, `dailyFee = 0.5%`, `tenor = 7 days`:

```
E[F] = 30 * 0.005 * 7 = $1.05
y * E[F] = 0.10 * 1.05 = $0.105
```

**Premium Floor `P_floor`.** The governance-set minimum premium ensures RT participation. For the RT to rationally deposit USDC, the expected return must exceed the opportunity cost `r_opp`:

```
P_floor >= r_opp * Cap * T
```

The default `P_floor = $0.05` (50,000 micro-USDC) represents a minimum viable premium for small positions. Governance can adjust `P_floor` based on prevailing DeFi yields.

### 3.3.3 Effective Markup Resolution

The effective markup `m_vol` is resolved from two inputs:

1. **IV/RV ratio**: Computed from SOL option markets (Bybit and Binance ATM implied volatility divided by 30-day realized volatility).
2. **Markup floor**: A governance parameter (default: 1.05).

```
m_vol = max(markupFloor, IV/RV)
```

When IV data is unavailable (e.g., during exchange outages or for illiquid option markets), the protocol defaults to `m_vol = markupFloor`.

When IV data is available from multiple exchanges, the protocol selects the **lower** IV to provide competitive (LP-friendly) pricing:

```
IV_effective = min(IV_Binance, IV_Bybit)
m_vol = max(markupFloor, IV_effective / RV)
```

## 3.4 Heuristic On-Chain Proxy

### 3.4.1 Motivation

The Simpson/GH quadrature requires floating-point arithmetic and is computationally expensive for on-chain execution on Solana's BPF runtime (limited to integer operations, no `exp` or `sqrt` on floats). The heuristic proxy provides a gas-efficient approximation using only integer arithmetic.

### 3.4.2 Components

The heuristic FV proxy decomposes the premium into five additive components:

**Hit Probability `p_hit`.** The probability that the price moves enough to generate a payout:

```
p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
```

In PPM integer arithmetic:

```
p_hit_ppm = min(PPM, 900_000 * sigma_ppm * sqrt_T_ppm / PPM / width_ppm)
```

where `sqrt_T_ppm = integerSqrt(T_ppm * PPM)` and `T_ppm = tenorSeconds * PPM / secondsPerYear`.

**Expected Payout `E[Payout]`.** The expected loss given a hit, scaled by severity:

```
E[Payout] = Cap * p_hit * severity / PPM^2
```

The severity parameter controls the expected loss magnitude conditional on the price being in the active range `[p_l, p_u]`. Higher severity means larger expected losses.

**Capital Charge `C_cap`.** A quadratic utilization-based charge reflecting the pool's concentration risk:

```
C_cap = Cap * (U_after / PPM)^2 / 5
```

where `U_after = (activeCapUsdc + capUsdc) / reservesUsdc` is the post-issuance utilization. The quadratic scaling penalizes high utilization more than proportionally, discouraging excessive concentration.

**Adverse Selection Charge `C_adv`.** An additive charge applied during stress regimes:

```
C_adv = Cap / 10,   if stress flag is true
C_adv = 0,          otherwise
```

This compensates the RT for the increased probability and severity of payouts during market stress.

**Replication Cost `C_rep`.** A carry cost for the RT's capital commitment:

```
C_rep = Cap * carry_bps * tenor_seconds / BPS / (100 * 86_400)
```

This reflects the opportunity cost of locked capital over the tenor.

**Total Heuristic FV:**

```
FV_heuristic = clamp(E[Payout] + C_cap + C_adv + C_rep, 0, ceiling)
```

### 3.4.3 Severity Calibration

The severity parameter bridges the heuristic and the numerical FV. It is calibrated so that:

```
E[Payout]_heuristic ~ FV_quadrature - (C_cap + C_adv + C_rep)
```

Solving for severity:

```
severity = (FV_target - non_severity_costs) * PPM^2 / (Cap * p_hit)
```

The calibration uses a geometric proxy for `FV_target`:

```
FV_target ~ Cap * p_hit * (width/2) / PPM
```

This approximation captures the average signed payoff in the active range under GBM. The severity is clamped to `[1, PPM]` (i.e., 0.0001% to 100%).

**Algorithm:**

```
1. Compute p_hit from sigma, T, width
2. Compute non-severity costs: C_cap + C_adv + C_rep
3. Estimate FV_target via geometric proxy
4. Compute ePayoutTarget = FV_target - non_severity_costs
5. severity = ePayoutTarget * PPM^2 / (Cap * p_hit)
6. Clamp severity to [1, PPM]
7. Apply bounded feedback correction (Section 5.5)
```

### 3.4.4 Heuristic vs. Quadrature: Calibration Quality

For the default parameters (`sigma = 65%`, `T = 7 days`, `width = +/-10%`), the bootstrap severity is 380,000 PPM (38%). Empirical comparison:

| Metric | GH Quadrature FV | Heuristic FV | Relative Error |
|--------|-------------------|--------------|----------------|
| `sigma = 40%` | Lower | Lower | ~8% |
| `sigma = 65%` | Baseline | Baseline | ~5% |
| `sigma = 90%` | Higher | Higher | ~12% |

The dynamic severity calibration (Section 5.5) reduces the steady-state error to below 5% through feedback correction.

## 3.5 Worked Example

**Setup:**
- `S_0 = $150.00` (entry price)
- `sigma = 65%` annualized
- Width: `+/-10%` => `p_l = $135.00`, `p_u = $165.00`
- `L = 50` (liquidity)
- Tenor: 7 days
- Pool: \$100 reserves, 0% utilization
- `m_vol = 1.08` (IV/RV ratio)
- `y = 0.10` (fee-split rate)
- Daily fee rate: 0.5%

**Step 1: Natural Cap**

```
V(150) = 50 * (2*sqrt(150) - 150/sqrt(165) - sqrt(135))
       = 50 * (2*12.247 - 11.676 - 11.619)
       = 50 * 1.200 = $60.00

V(135) = 50 * (sqrt(135) - 135/sqrt(165))
       = 50 * (11.619 - 10.510)
       = 50 * 1.110 = $55.48

Cap = 60.00 - 55.48 = $4.52
```

**Step 2: Fair Value (Simpson's Rule)**

Numerically integrating `PI(S_T(z)) * phi(z)` over `z in [-6, 6]` with `N = 200`:

```
drift = -0.5 * 0.65^2 * 7/365 = -0.00405
vol = 0.65 * sqrt(7/365) = 0.0900

For each z_i:
  S_T = 150 * exp(-0.00405 + 0.0900 * z_i)
  PI(S_T) = V(S_0) − V(clamp(S_T, p_l, p_u))   (signed)
  g(z_i) = PI(S_T) * phi(z_i)

FV_swap ≈ FV_put_spread − FV_call_spread
        ≈ \$0.63 − \$0.25
        ≈ \$0.38
```

The swap's FV is roughly 60% of the capped-put FV at these parameters: the upside-giveup leg (`FV_call_spread ≈ \$0.25`) partially offsets the downside leg (`FV_put_spread ≈ \$0.63`). The difference shrinks for narrower widths (where both caps are smaller) and widens for wider widths.

**Step 3: Fee Discount**

```
E[F] = 6_000_000 * 0.005 * 7 = $0.21 (210,000 micro-USDC)
y * E[F] = 0.10 * 210,000 = $0.021 (21,000 micro-USDC)
```

(Note: notional used here is the position entry value of ~\$6.00.)

**Step 4: Canonical Premium**

```
Raw = FV_swap * m_vol - y * E[F]
    = 380,000 * 1.08 - 21,000
    = 410,400 - 21,000
    = 389,400 micro-USDC (\$0.389)

Premium = max(P_floor, Raw) = max(50,000, 389,400) = 389,400 micro-USDC
```

**Step 5: Protocol Fee**

```
protocolFee = 389,400 * 150 / 10,000 = 5,841 micro-USDC (\$0.006)
premiumToPool = 389,400 - 5,841 = 383,559 micro-USDC (\$0.383)
```

**Summary (Liquidity Hedge swap vs. capped-put reference):**

| Component | Value (micro-USDC) | Value (USD) | Capped-put reference |
|-----------|-------------------|-------------|----------------------|
| Fair Value (FV_swap) | 380,000 | \$0.380 | (FV_put ≈ \$0.630) |
| Markup (m_vol = 1.08) | 410,400 | \$0.410 | (\$0.680) |
| Fee Discount | -21,000 | -\$0.021 | -\$0.021 |
| Raw Premium | 389,400 | \$0.389 | \$0.659 |
| P_floor | 50,000 | \$0.050 | \$0.050 |
| **Final Premium** | **389,400** | **\$0.389** | **\$0.659** |
| Protocol Fee (1.5%) | 5,841 | \$0.006 | \$0.010 |
| To Pool | 383,559 | \$0.383 | \$0.650 |

The swap premium is ~40% lower than the equivalent capped-put premium for the same risk parameters — the LP pays less upfront in exchange for surrendering the (bounded, concavity-adjusted) upside above `S_0` to the RT.

## 3.6 References for This Section

- [8] Black, F. & Scholes, M. (1973). "The Pricing of Options and Corporate Liabilities."
- [9] Merton, R.C. (1973). "Theory of Rational Option Pricing."
- [10] Hull, J.C. (2018). *Options, Futures, and Other Derivatives*, 10th ed. Pearson.
- [12] Abramowitz, M. & Stegun, I.A. (1964). *Handbook of Mathematical Functions*. Dover.
- [13] Press, W.H., Teukolsky, S.A., Vetterling, W.T., & Flannery, B.P. (2007). *Numerical Recipes*, 3rd ed. Cambridge University Press.
- [14] Carr, P. & Wu, L. (2009). "Variance Risk Premiums." *Review of Financial Studies*, 22(3), 1311--1341.
- [15] Bollerslev, T., Tauchen, G., & Zhou, H. (2009). "Expected Stock Returns and Variance Risk Premia." *Review of Financial Studies*, 22(11), 4463--4492.
