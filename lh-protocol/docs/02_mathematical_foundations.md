# 2. Mathematical Foundations

## 2.1 Concentrated Liquidity Mechanics

### 2.1.1 Tick Mathematics

Concentrated liquidity AMMs (Uniswap V3 [1], Orca Whirlpools) discretize the price space into *ticks*. A tick index `i` maps to a price via:

```
p(i) = 1.0001^i
```

For the SOL/USDC pair with decimal difference `d_A - d_B = 9 - 6 = 3`, the human-readable price is:

```
S(i) = 1.0001^i * 10^(d_A - d_B) = 1.0001^i * 1000
```

The tick spacing for the 1% fee tier on Orca is 64, meaning valid tick indices are multiples of 64. A CL position is defined by:

- A lower tick `i_l` and upper tick `i_u`, yielding price bounds `p_l = p(i_l)` and `p_u = p(i_u)`.
- A liquidity parameter `L >= 0` representing the depth of liquidity provided.

The AMM uses sqrt-price in Q64.64 fixed-point representation:

```
sqrtPrice_X64 = floor(sqrt(p(i)) * 2^64)
```

This representation avoids floating-point arithmetic on-chain and enables exact integer computations for token amount calculations.

### 2.1.2 The CL Value Function V(S)

The value of a concentrated liquidity position at spot price `S` is a function `V: R_+ -> R_+` defined piecewise in three regimes. All values are denominated in token B (USDC).

**Definition 2.1** (CL Value Function). For a position with liquidity `L` and price bounds `[p_l, p_u]` where `0 < p_l < p_u`:

```
           { L * (1/sqrt(p_l) - 1/sqrt(p_u)) * S,          if S <= p_l     (I)
V(S; L) = { L * (2*sqrt(S) - S/sqrt(p_u) - sqrt(p_l)),    if p_l < S < p_u (II)
           { L * (sqrt(p_u) - sqrt(p_l)),                   if S >= p_u     (III)
```

The three regimes correspond to:

- **Regime I** (`S <= p_l`): The position holds only token A (SOL). The value is linear in `S`, since the token A quantity is fixed at `L * (1/sqrt(p_l) - 1/sqrt(p_u))`.
- **Regime II** (`p_l < S < p_u`): The position holds a mix of tokens A and B. Value is a concave function of `S`.
- **Regime III** (`S >= p_u`): The position holds only token B (USDC). The value is constant at `L * (sqrt(p_u) - sqrt(p_l))`.

**Derivation of Regime II.** Within the range, the token amounts are [1]:

```
amount_A(S) = L * (1/sqrt(S) - 1/sqrt(p_u))
amount_B(S) = L * (sqrt(S) - sqrt(p_l))
```

The total value in token B units is:

```
V(S) = amount_A(S) * S + amount_B(S)
     = L * (S/sqrt(S) - S/sqrt(p_u)) + L * (sqrt(S) - sqrt(p_l))
     = L * (sqrt(S) - S/sqrt(p_u) + sqrt(S) - sqrt(p_l))
     = L * (2*sqrt(S) - S/sqrt(p_u) - sqrt(p_l))
```

**Continuity.** The value function is continuous at the boundaries:

At `S = p_l`:
```
Regime I:  V(p_l) = L * (1/sqrt(p_l) - 1/sqrt(p_u)) * p_l = L * (sqrt(p_l) - p_l/sqrt(p_u))
Regime II: V(p_l) = L * (2*sqrt(p_l) - p_l/sqrt(p_u) - sqrt(p_l)) = L * (sqrt(p_l) - p_l/sqrt(p_u))
```

At `S = p_u`:
```
Regime II:  V(p_u) = L * (2*sqrt(p_u) - p_u/sqrt(p_u) - sqrt(p_l)) = L * (sqrt(p_u) - sqrt(p_l))
Regime III: V(p_u) = L * (sqrt(p_u) - sqrt(p_l))
```

### 2.1.3 Proof of Concavity

**Theorem 2.1.** The CL value function `V(S)` is concave on `(0, infinity)`.

*Proof.* We verify concavity regime by regime:

**Regime I** (`S <= p_l`): `V(S) = c_1 * S` where `c_1 = L * (1/sqrt(p_l) - 1/sqrt(p_u)) > 0`. This is linear, hence concave (weakly).

**Regime II** (`p_l < S < p_u`): Compute the second derivative:

```
dV/dS = L * (1/sqrt(S) - 1/sqrt(p_u))

d^2V/dS^2 = -L / (2 * S^(3/2))
```

Since `L > 0` and `S > 0`, we have `d^2V/dS^2 < 0`, confirming strict concavity.

Note that `dV/dS > 0` for `S < p_u` (since `1/sqrt(S) > 1/sqrt(p_u)`), confirming that `V` is increasing within the range. At `S = p_u`, the derivative `dV/dS = 0`, consistent with the transition to the constant regime.

**Regime III** (`S >= p_u`): `V(S) = c_3` (constant), hence concave (weakly).

**Across boundaries:** Concavity is preserved at `S = p_l` and `S = p_u` because the left derivative exceeds the right derivative at each boundary:

At `S = p_l`:
```
dV/dS|_{left}  = c_1 = L * (1/sqrt(p_l) - 1/sqrt(p_u))
dV/dS|_{right} = L * (1/sqrt(p_l) - 1/sqrt(p_u)) = c_1
```

The derivatives match at `p_l`, so `V` is C^1 there.

At `S = p_u`:
```
dV/dS|_{left}  = L * (1/sqrt(p_u) - 1/sqrt(p_u)) = 0
dV/dS|_{right} = 0
```

The derivatives also match at `p_u`. Thus `V` is C^1 on `(0, infinity)` and `d^2V/dS^2 <= 0` everywhere, establishing global concavity. QED.

**Corollary 2.1.** The impermanent loss `IL(S) = V(S_0) - V(S)` is convex on `(0, infinity)` for any fixed `S_0 in (p_l, p_u)`.

### 2.1.4 Token Amounts in Q64.64 Fixed-Point

For on-chain computation, token amounts are derived from liquidity `L` and sqrt-prices in Q64.64 format. Let `sqrtP_c`, `sqrtP_l`, `sqrtP_u` denote the current, lower, and upper sqrt-prices respectively. Then:

```
Below range (sqrtP_c <= sqrtP_l):
  amount_A = L * (sqrtP_u - sqrtP_l) * 2^64 / (sqrtP_l * sqrtP_u)
  amount_B = 0

Above range (sqrtP_c >= sqrtP_u):
  amount_A = 0
  amount_B = L * (sqrtP_u - sqrtP_l) / 2^64

In range (sqrtP_l < sqrtP_c < sqrtP_u):
  amount_A = L * (sqrtP_u - sqrtP_c) * 2^64 / (sqrtP_c * sqrtP_u)
  amount_B = L * (sqrtP_c - sqrtP_l) / 2^64
```

## 2.2 Geometric Brownian Motion Model

### 2.2.1 The SDE and Its Solution

We model the SOL/USDC spot price under the risk-neutral measure using geometric Brownian motion (GBM) [8, 9]:

```
dS / S = sigma * dW
```

where `sigma > 0` is the annualized volatility and `W` is a standard Wiener process. Under the risk-neutral measure, the drift is zero (cryptocurrency markets with no dividend/convenience yield).

The solution is:

```
S_T = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * Z)
```

where `Z ~ N(0, 1)` is a standard normal random variable and `T` is the time to expiry in years.

### 2.2.2 Log-Normal Distribution

The terminal price `S_T` is log-normally distributed:

```
ln(S_T) ~ N(ln(S_0) - sigma^2/2 * T, sigma^2 * T)
```

The probability density function of `S_T` is:

```
f(S_T) = (1 / (S_T * sigma * sqrt(2 * pi * T))) 
       * exp(-(ln(S_T/S_0) + sigma^2*T/2)^2 / (2 * sigma^2 * T))
```

Equivalently, via the substitution `z = (ln(S_T/S_0) + sigma^2*T/2) / (sigma * sqrt(T))`:

```
S_T(z) = S_0 * exp(-sigma^2/2 * T + sigma * sqrt(T) * z)

E[g(S_T)] = integral from -inf to +inf of g(S_T(z)) * phi(z) dz
```

where `phi(z) = exp(-z^2/2) / sqrt(2*pi)` is the standard normal PDF.

### 2.2.3 GBM Assumptions and Limitations

The GBM model assumes:

1. Constant volatility `sigma` over the tenor `T`.
2. Continuous price paths (no jumps).
3. Log-normal returns.

Empirical limitations for SOL include fat tails, volatility clustering, and occasional liquidity-driven jumps. The protocol addresses these through:

- The variance risk premium markup `m_vol` (Section 3), which adjusts for the market-implied cost of volatility uncertainty.
- The stress flag and adverse selection charge (Section 5), which provide explicit regime-dependent adjustments.
- The premium floor `P_floor` (Section 3), which sets a governance-determined minimum regardless of model output.

## 2.3 The Corridor Payoff

### 2.3.1 Formal Definition

**Definition 2.2** (Corridor Payoff). For a CL position with entry price `S_0 in (p_l, p_u)`, liquidity `L`, price bounds `[p_l, p_u]`, and natural cap `Cap = V(S_0) - V(p_l)`:

```
PI(S_T) = min(Cap, max(0, V(S_0) - V(max(S_T, B))))
```

where `B = p_l` is the barrier price, equal to the lower bound of the CL position.

### 2.3.2 Piecewise Expansion

Expanding the definition over the three price regimes:

```
PI(S_T) = 0,                         if S_T >= S_0   (no loss)
PI(S_T) = V(S_0) - V(S_T),           if B <= S_T < S_0   (partial loss)
PI(S_T) = Cap = V(S_0) - V(B),       if S_T < B   (maximum loss)
```

In the partial loss regime (`B <= S_T < S_0`), substituting the Regime II value function:

```
PI(S_T) = V(S_0) - V(S_T)
        = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - sqrt(p_l))
        - L * (2*sqrt(S_T) - S_T/sqrt(p_u) - sqrt(p_l))
        = L * (2*(sqrt(S_0) - sqrt(S_T)) - (S_0 - S_T)/sqrt(p_u))
```

This is a non-linear function of `S_T`, reflecting the concavity of the CL value function.

### 2.3.3 Properties of the Corridor Payoff

**Proposition 2.1.** The corridor payoff `PI(S_T)` has the following properties:

(i) **Non-negativity**: `PI(S_T) >= 0` for all `S_T > 0`.

(ii) **Boundedness**: `PI(S_T) <= Cap = V(S_0) - V(B)` for all `S_T > 0`.

(iii) **Monotonicity**: `PI` is non-increasing in `S_T` for `S_T in [B, S_0]`.

(iv) **Exact IL replication**: For `S_T in [B, S_0]`, `PI(S_T) = V(S_0) - V(S_T)`, which equals the impermanent loss of the CL position.

(v) **Continuity**: `PI` is continuous on `(0, infinity)`.

*Proof.*

(i) Follows from `max(0, ...)` in the definition.

(ii) In the partial loss regime, `PI = V(S_0) - V(S_T) <= V(S_0) - V(B) = Cap` since `V` is non-decreasing on `[B, S_0]` (Theorem 2.1) and `S_T >= B`. In the max-loss regime, `PI = Cap` by definition.

(iii) `dPI/dS_T = -dV/dS_T = -L * (1/sqrt(S_T) - 1/sqrt(p_u)) < 0` for `S_T in (B, S_0) subset (p_l, p_u)`.

(iv) By construction: for `B <= S_T < S_0`, the `max` operation yields `V(S_0) - V(S_T)`, and the `min` with `Cap` does not bind since `V(S_T) >= V(B)` implies `V(S_0) - V(S_T) <= Cap`.

(v) Continuity follows from the continuity of `V(S)` (proven in Section 2.1.2) and the continuity of `max` and `min` operations. QED.

### 2.3.4 Natural Cap Derivation

**Definition 2.3** (Natural Cap). The natural cap is the maximum possible corridor payoff:

```
Cap = V(S_0) - V(B) = V(S_0) - V(p_l)
```

Since `S_0 in (p_l, p_u)` and `B = p_l`, using the value function:

```
V(S_0) = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - sqrt(p_l))           [Regime II]
V(B)   = V(p_l) = L * (sqrt(p_l) - p_l/sqrt(p_u))                 [boundary of I/II]
```

Therefore:

```
Cap = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - sqrt(p_l)) 
    - L * (sqrt(p_l) - p_l/sqrt(p_u))
    = L * (2*sqrt(S_0) - S_0/sqrt(p_u) - 2*sqrt(p_l) + p_l/sqrt(p_u))
    = L * (2*(sqrt(S_0) - sqrt(p_l)) - (S_0 - p_l)/sqrt(p_u))
```

**Example.** For `S_0 = 150`, `p_l = 135` (`-10%`), `p_u = 165` (`+10%`), `L = 50`:

```
sqrt(150) = 12.247, sqrt(135) = 11.619, sqrt(165) = 12.845

V(150) = 50 * (2*12.247 - 150/12.845 - 11.619) = 50 * (24.495 - 11.676 - 11.619) = 50 * 1.200 = 60.00
V(135) = 50 * (11.619 - 135/12.845) = 50 * (11.619 - 10.510) = 50 * 1.110 = 55.48

Cap = 60.00 - 55.48 = 4.52 USDC
```

The natural cap ensures full coverage: no separate cover ratio parameter is needed because the payoff is bounded by construction at the IL incurred when the price reaches the lower bound of the position.

### 2.3.5 Comparison with Alternative Payoffs

| Feature | Corridor Certificate | Put Spread | Perpetual Delta Hedge |
|---------|---------------------|------------|----------------------|
| Basis risk | Zero (exact IL match) | Non-zero (linear vs concave) | Gamma error |
| Max liability | `Cap` (known at issuance) | Strike difference | Unbounded (funding) |
| Parameters | Derived from CL position | Independent strikes | Continuous rebalancing |
| Operational cost | One-time premium | One-time premium | Ongoing funding + margin |
| Settlement | Single cash payment | Option exercise | Continuous |

## 2.4 Value-Neutrality Theorem

The corridor hedge certificate is a *pure redistribution mechanism*: it transfers impermanent loss risk from LP to RT without creating or destroying economic value. This section formalizes this property and derives its consequences for two-sided viability.

### 2.4.1 Per-Week PnL Decomposition

For a single hedge cycle (one week), define:

| Symbol | Definition |
|--------|-----------|
| `ΔV_w` | CL position PnL: `V(S_{w+1}) - V(S_w)` |
| `F_w` | LP trading fees earned during week `w` |
| `P_w` | Premium paid by the LP for the corridor certificate |
| `Π_w` | Corridor payoff received by the LP at settlement |
| `y` | Fee-split rate: fraction of LP fees transferred to RT |
| `φ` | Protocol fee rate: `protocolFeeBps / BPS` (e.g., 0.015) |

The three participants' PnL:

```
Unhedged LP:    U_w  = ΔV_w + F_w

Hedged LP:      LP_w = ΔV_w + F_w(1 − y) − P_w + Π_w

Risk Taker:     RT_w = P_w(1 − φ) + yF_w − Π_w
```

### 2.4.2 Aggregate Cancellation

**Theorem 2.2 (Value Neutrality).** *The sum of hedged LP and RT PnL equals the unhedged LP PnL minus the protocol fee:*

```
LP_w + RT_w = U_w − φP_w
```

*Proof.* Expand and collect terms:

```
LP_w + RT_w = [ΔV_w + F_w(1−y) − P_w + Π_w] + [P_w(1−φ) + yF_w − Π_w]
            = ΔV_w + F_w − F_wy + F_wy − P_w + P_w − φP_w + Π_w − Π_w
            = ΔV_w + F_w − φP_w
            = U_w − φP_w                                              □
```

The premium `P_w` cancels (LP pays, RT receives). The payout `Π_w` cancels (RT pays, LP receives). The fee split `yF_w` cancels (LP forgoes, RT receives). The *only leakage* is the protocol treasury fee `φP_w`.

### 2.4.3 Two-Sided Viability Condition

Summing over `W` weeks:

```
Σ_w LP_w + Σ_w RT_w = Σ_w U_w − φ Σ_w P_w
```

Two-sided viability requires `Σ LP_w ≥ 0` and `Σ RT_w ≥ 0`. A necessary condition is:

```
Σ_w U_w ≥ φ Σ_w P_w                                        (*)
```

**This condition is also sufficient.** If (*) holds, set governance parameters `(P_floor, y)` so that `Σ RT_w = 0` (RT exactly breaks even). Then:

```
Σ LP_w = Σ U_w − φ Σ P_w ≥ 0
```

by (*). Since the parameter space `(P_floor, y)` is continuous and RT PnL is monotonically increasing in `P_floor` and `y`, the intermediate value theorem guarantees the existence of a breakeven point.

### 2.4.4 Breakeven Fee Yield Equivalence

The LP fee income `F_w` is proportional to the daily fee yield `r`:

```
F_w = V_w · r · 7
```

where `V_w` is the position value at week `w`. The unhedged LP breakeven yield `r_u` satisfies:

```
Σ_w (ΔV_w + V_w · r_u · 7) = 0
```

The two-sided breakeven yield `r*` satisfies condition (*) with equality:

```
Σ_w (ΔV_w + V_w · r* · 7) = φ Σ_w P_w
```

Subtracting:

```
r* − r_u = φ Σ_w P_w / (7 · Σ_w V_w)
```

**Corollary 2.1.** *The two-sided breakeven yield exceeds the unhedged breakeven yield by exactly `φ Σ P_w / (7 Σ V_w)`. When the protocol fee is zero (`φ = 0`), the two quantities are identical:*

```
φ = 0  ⟹  r* = r_u
```

*The corridor hedge is a zero-cost redistribution: it reduces the LP's PnL volatility without raising the minimum fee yield needed for profitability.*

### 2.4.5 Magnitude of the Protocol Fee Wedge

At the default protocol fee of `φ = 0.015` (1.5%), for a ±10% position with `V_0 ≈ $11,000` and average weekly premium `P̄ ≈ $193`:

```
r* − r_u = 0.015 × 193 / (7 × 11,000) ≈ 0.000038 = 0.38 bps/day
```

This is consistent with the empirical simulation result of 0.3 bps/day (see Section 8.4). The protocol fee introduces a wedge of approximately 1% of the premium-to-position ratio, which is economically negligible.

### 2.4.6 Implications

1. **The hedge is efficient.** Risk transfer from LP to RT costs only the protocol fee, not the premium itself. The premium is a transfer, not a cost to the system.

2. **Governance is distributional.** Parameters `P_floor` and `y` determine *how* the surplus is split between LP and RT. They do not determine *whether* a surplus exists — that depends solely on `Σ U_w`, i.e., whether the unhedged position is profitable.

3. **Viability is yield-determined.** The protocol is two-sided viable at any fee yield where the unhedged LP is profitable. No novel economic surplus is required — the same surplus that makes unhedged LPing viable also makes hedged LPing viable.

4. **The protocol fee is the only friction.** In the limit `φ → 0`, the corridor hedge is a Pareto improvement: the LP's risk decreases while neither party's expected return changes.

## 2.5 References for This Section

- [1] Adams, H., Zinsmeister, N., Salem, M., Keefer, R., & Robinson, D. (2021). "Uniswap v3 Core."
- [2] Lambert, G., Legrand, B., & Pfister, T. (2021). "Uniswap V3 LP Tokens as Perpetual Put and Call Options."
- [3] Loesch, S., Hindman, N., Richardson, M., & Welch, N. (2021). "Impermanent Loss in Uniswap V3."
- [8] Black, F. & Scholes, M. (1973). "The Pricing of Options and Corporate Liabilities." *Journal of Political Economy*, 81(3), 637--654.
- [9] Merton, R.C. (1973). "Theory of Rational Option Pricing." *Bell Journal of Economics*, 4(1), 141--183.
