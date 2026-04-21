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

## 2.3 The Liquidity Hedge Payoff

### 2.3.1 Formal Definition

**Definition 2.2** (Liquidity Hedge Payoff). For a CL position with entry price `S_0 in (p_l, p_u)` and liquidity `L`, the **Liquidity Hedge payoff** at settlement price `S_T > 0` is the signed swap

```
PI(S_T) = V(S_0) - V(clamp(S_T, p_l, p_u))
```

where `clamp(x, a, b) = min(max(x, a), b)`. This is a bilateral payoff: positive values are paid by the RT pool to the LP (downside realized); negative values are paid by the LP to the RT pool (upside surrendered).

### 2.3.2 Piecewise Expansion

Expanding over the three price regimes defined by the CL range `[p_l, p_u]`:

```
PI(S_T) = +Cap_down  = V(S_0) - V(p_l),             if S_T <= p_l        (max downside)
PI(S_T) = V(S_0) - V(S_T),                          if p_l <= S_T <= p_u (exact IL replication, signed)
PI(S_T) = -Cap_up    = -(V(p_u) - V(S_0)),          if S_T >= p_u        (max upside give-up)
```

Inside the active range, substituting the Regime II value function gives

```
PI(S_T) = L * (2*(sqrt(S_0) - sqrt(S_T)) - (S_0 - S_T)/sqrt(p_u))
```

which is concave in `S_T` and equals the signed impermanent loss of the CL position at every interior point. Outside `[p_l, p_u]` the payoff saturates at the two natural caps defined below.

### 2.3.3 Natural Caps

**Definition 2.3** (Natural Caps).

```
Cap_down = V(S_0) - V(p_l)    (maximum RT liability)
Cap_up   = V(p_u) - V(S_0)    (maximum LP give-up, always covered by the escrowed position)
```

Both caps are non-negative and are intrinsic to the CL geometry — no cover ratio or external parameter is needed.

**Proposition 2.1** (Concavity wedge). *For any symmetric range `p_l = S_0(1 - w)`, `p_u = S_0(1 + w)` with `w in (0, 1)`:*

```
Cap_up  <  Cap_down
```

*Proof.* `V(S)` is concave on `[p_l, p_u]` (`V'' < 0`, §2.1.2, Theorem 2.1). The chord from `(p_l, V(p_l))` to `(p_u, V(p_u))` lies strictly below the curve at the interior point `S_0`, so

```
V(S_0) > (V(p_l) + V(p_u)) / 2  ⟹  V(S_0) - V(p_l) > V(p_u) - V(S_0).
```

□

This is the **convexity adjustment** that makes the hedge positively priced: the RT takes on a larger downside cap than the upside cap they collect, and charges the LP a premium equal to the risk-neutral expectation of the signed payoff (Section 3).

**Example.** For `S_0 = 150`, `p_l = 135`, `p_u = 165`, `L = 50`:

```
V(150) = 60.00,  V(135) = 55.48,  V(165) = 61.30

Cap_down = 60.00 − 55.48 = 4.52 USDC
Cap_up   = 61.30 − 60.00 = 1.30 USDC
```

The upside give-up is ~3.5× smaller than the downside protection — a direct consequence of the concavity of `V`.

### 2.3.4 Properties of the Liquidity Hedge Payoff

**Proposition 2.2.** The Liquidity Hedge payoff `PI(S_T)` has the following properties:

(i) **Boundedness**: `-Cap_up <= PI(S_T) <= Cap_down` for all `S_T > 0`.

(ii) **Sign**: `PI(S_T) >= 0` iff `S_T <= S_0`, and `PI(S_T) <= 0` iff `S_T >= S_0`.

(iii) **Monotonicity**: `PI` is non-increasing on `(0, infinity)` (strictly decreasing on `(p_l, p_u)`, constant outside).

(iv) **Exact IL replication**: For `S_T in [p_l, p_u]`, `PI(S_T) = V(S_0) - V(S_T)`, which *is* the signed impermanent loss of the CL position.

(v) **Continuity**: `PI` is continuous on `(0, infinity)`.

*Proof.*

(i) At the extremes of the clamp, `V(clamp(S_T, p_l, p_u)) in [V(p_l), V(p_u)]`, so `PI in [V(S_0) - V(p_u), V(S_0) - V(p_l)] = [-Cap_up, Cap_down]`.

(ii) `V` is strictly increasing on `(p_l, p_u)` (Theorem 2.1) and constant outside. Hence `V(clamp(S_T, p_l, p_u)) >= V(S_0)` iff `S_T >= S_0`, giving the claim.

(iii) `dPI/dS_T = -V'(clamp(S_T, p_l, p_u)) * 1_{p_l < S_T < p_u} <= 0` and is strictly negative in the open interior.

(iv) By construction: for `S_T in [p_l, p_u]` the clamp is the identity, so `PI(S_T) = V(S_0) - V(S_T)`.

(v) `V` is continuous and the clamp is continuous, so the composition is continuous. QED.

### 2.3.5 Settlement from Position Proceeds

When `PI(S_T) < 0` the LP owes the RT pool `|PI(S_T)| <= Cap_up`. This is settled **physically** from the LP's escrowed Orca position:

- At `S_T > p_u` the CL position is fully token B (USDC) worth `V(p_u)`. The LP's proceeds trivially cover the owed `Cap_up = V(p_u) - V(S_0)`, leaving the LP with exactly `V(S_0)`.
- At `S_0 < S_T < p_u` the position is a mix of token A and token B with USD value `V(S_T) > V(S_0)`. The owed amount `V(S_T) - V(S_0)` is at most the USDC leg of the mixed position.

No LP collateral, allowance, or liquidation machinery is required: the escrow is self-sufficient by the CL geometry.

### 2.3.6 Comparison with Alternative Payoffs

| Feature | Liquidity Hedge (swap) | Put Spread | Perpetual Delta Hedge |
|---------|------------------------|------------|----------------------|
| Payoff shape vs. IL | Exact match in `[p_l, p_u]` | Chord (over-hedges interior) | Gamma error |
| Left tail (`S_T < p_l`) | Capped at `+Cap_down` | Capped at `K_1 − K_2` | Unbounded (funding cost) |
| Right tail (`S_T > p_u`) | Capped at `−Cap_up` (LP pays RT) | Zero | Unbounded |
| Max RT liability | `Cap_down` (known at issuance) | Strike diff | Unbounded |
| Operational cost | One premium + physical settle | One premium | Continuous rebalancing |
| LP keeps upside above `S_0`? | No (surrendered to RT) | Yes | Yes (at cost of funding) |

## 2.4 Value-Neutrality Theorem

The Liquidity Hedge certificate is a *pure redistribution mechanism*: it transfers the CL position's full mark-to-market variability within `[p_l, p_u]` from LP to RT without creating or destroying economic value. This section formalizes this property and derives its consequences for two-sided viability.

The theorem and its proof are independent of the sign of `Π_w` — they depend only on the additive structure of the cash flows. They therefore hold verbatim for the signed swap payoff introduced in §2.3 (Definition 2.2), with `Π_w` now potentially negative (LP pays RT) for settlements above `S_0`.

### 2.4.1 Per-Week PnL Decomposition

For a single hedge cycle (one week), define:

| Symbol | Definition |
|--------|-----------|
| `ΔV_w` | CL position PnL: `V(S_{w+1}) - V(S_w)` |
| `F_w` | LP trading fees earned during week `w` |
| `P_w` | Premium paid by the LP for the Liquidity Hedge certificate |
| `Π_w` | Signed Liquidity Hedge payoff at settlement (Definition 2.2): positive ⇒ RT→LP, negative ⇒ LP→RT |
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

*The Liquidity Hedge is a zero-cost redistribution: it collapses the LP's PnL to `V(S_0) − P_w + (1 − y) F_w` inside the active range without raising the minimum fee yield needed for profitability.*

### 2.4.5 Magnitude of the Protocol Fee Wedge

At the default protocol fee of `φ = 0.015` (1.5%), the wedge scales with the average premium `P̄`. Under the signed-swap payoff (Definition 2.2), the backtest in §8.5 observed `P̄ ≈ \$129/wk` at the joint-breakeven configuration for a ±10% position with `V_0 ≈ \$11,000`, giving a theoretical wedge of

```
r* − r_u  ≈  0.015 × 129 / (7 × 11,000)  ≈  0.25 bps/day
```

matching the observed 0.2–0.3 bps/day in §8.5.3. Under the earlier capped-put baseline the corresponding `P̄ ≈ \$193/wk` gave a theoretical 0.38 bps/day wedge. The swap's smaller `P̄` therefore makes the hedge even closer to free in aggregate, because less premium flows through the treasury fee.

### 2.4.6 Implications

1. **The hedge is efficient.** Risk transfer from LP to RT costs only the protocol fee, not the premium itself. The premium is a transfer, not a cost to the system.

2. **Governance is distributional.** Parameters `P_floor` and `y` determine *how* the surplus is split between LP and RT. They do not determine *whether* a surplus exists — that depends solely on `Σ U_w`, i.e., whether the unhedged position is profitable.

3. **Viability is yield-determined.** The protocol is two-sided viable at any fee yield where the unhedged LP is profitable. No novel economic surplus is required — the same surplus that makes unhedged LPing viable also makes hedged LPing viable.

4. **The protocol fee is the only friction.** In the limit `φ → 0`, the Liquidity Hedge is a Pareto improvement: the LP's risk decreases while neither party's expected return changes.

## 2.5 References for This Section

- [1] Adams, H., Zinsmeister, N., Salem, M., Keefer, R., & Robinson, D. (2021). "Uniswap v3 Core."
- [2] Lambert, G., Legrand, B., & Pfister, T. (2021). "Uniswap V3 LP Tokens as Perpetual Put and Call Options."
- [3] Loesch, S., Hindman, N., Richardson, M., & Welch, N. (2021). "Impermanent Loss in Uniswap V3."
- [8] Black, F. & Scholes, M. (1973). "The Pricing of Options and Corporate Liabilities." *Journal of Political Economy*, 81(3), 637--654.
- [9] Merton, R.C. (1973). "Theory of Rational Option Pricing." *Bell Journal of Economics*, 4(1), 141--183.
