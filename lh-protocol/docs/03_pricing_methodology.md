# 3. Pricing Methodology

## 3.1 Fair Value as Risk-Neutral Expectation

The fair value (FV) of the corridor certificate is the discounted risk-neutral expectation of the corridor payoff. Since the tenor is short (7 days) and USDC is the numeraire, we neglect discounting and define:

```
FV = E^Q[PI(S_T)] = integral from 0 to infinity of PI(S_T) * f(S_T) dS_T
```

where `f(S_T)` is the risk-neutral density of `S_T` under GBM (Section 2.2.2) and `PI(S_T)` is the corridor payoff (Definition 2.2).

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
2. Evaluate the corridor payoff: `PI(S_T)` using the CL value function
3. Weight by the normal PDF: `g(z_i) = PI(S_T) * phi(z_i)`

### 3.2.3 Convergence Analysis

Simpson's rule has error `O(h^4)` for smooth integrands [12, 13]. The integrand `g(z) = PI(S_T(z)) * phi(z)` is:

- Continuous everywhere (Proposition 2.1(v))
- C^1 except at `z` values mapping to `S_T = S_0` and `S_T = B`, where `PI` has derivative discontinuities

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

- `FV` = fair value of the corridor payoff (risk-neutral expectation, Section 3.1)
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

The severity parameter controls the expected loss magnitude conditional on the price being in the corridor. Higher severity means larger expected losses.

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

This approximation captures the average payoff in the corridor under GBM. The severity is clamped to `[1, PPM]` (i.e., 0.0001% to 100%).

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
- Pool: $100 reserves, 0% utilization
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
  PI(S_T) = corridor payoff at S_T
  g(z_i) = PI(S_T) * phi(z_i)

FV = Simpson sum ~ $0.63
```

**Step 3: Fee Discount**

```
E[F] = 6_000_000 * 0.005 * 7 = $0.21 (210,000 micro-USDC)
y * E[F] = 0.10 * 210,000 = $0.021 (21,000 micro-USDC)
```

(Note: notional used here is the position entry value of ~$6.00.)

**Step 4: Canonical Premium**

```
Raw = FV * m_vol - y * E[F]
    = 630,000 * 1.08 - 21,000
    = 680,400 - 21,000
    = 659,400 micro-USDC ($0.659)

Premium = max(P_floor, Raw) = max(50,000, 659,400) = 659,400 micro-USDC
```

**Step 5: Protocol Fee**

```
protocolFee = 659,400 * 150 / 10,000 = 9,891 micro-USDC ($0.010)
premiumToPool = 659,400 - 9,891 = 649,509 micro-USDC ($0.650)
```

**Summary:**

| Component | Value (micro-USDC) | Value (USD) |
|-----------|-------------------|-------------|
| Fair Value (FV) | 630,000 | $0.630 |
| Markup (m_vol = 1.08) | 680,400 | $0.680 |
| Fee Discount | -21,000 | -$0.021 |
| Raw Premium | 659,400 | $0.659 |
| P_floor | 50,000 | $0.050 |
| **Final Premium** | **659,400** | **$0.659** |
| Protocol Fee (1.5%) | 9,891 | $0.010 |
| To Pool | 649,509 | $0.650 |

## 3.6 References for This Section

- [8] Black, F. & Scholes, M. (1973). "The Pricing of Options and Corporate Liabilities."
- [9] Merton, R.C. (1973). "Theory of Rational Option Pricing."
- [10] Hull, J.C. (2018). *Options, Futures, and Other Derivatives*, 10th ed. Pearson.
- [12] Abramowitz, M. & Stegun, I.A. (1964). *Handbook of Mathematical Functions*. Dover.
- [13] Press, W.H., Teukolsky, S.A., Vetterling, W.T., & Flannery, B.P. (2007). *Numerical Recipes*, 3rd ed. Cambridge University Press.
- [14] Carr, P. & Wu, L. (2009). "Variance Risk Premiums." *Review of Financial Studies*, 22(3), 1311--1341.
- [15] Bollerslev, T., Tauchen, G., & Zhou, H. (2009). "Expected Stock Returns and Variance Risk Premia." *Review of Financial Studies*, 22(11), 4463--4492.
