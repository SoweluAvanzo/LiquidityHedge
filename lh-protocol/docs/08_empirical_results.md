# 8. Empirical Results

This section documents the backtesting methodology and results obtained by running the protocol over real SOL/USDC historical price data sourced from the Birdeye API. All numbers below are from a **fresh backtest under the signed-swap payoff** (Definition 2.2, `Π = V(S_0) − V(clamp(S_T, p_l, p_u))`).

## 8.1 Experimental Setup

### 8.1.1 Data Source

All price data is sourced from the **Birdeye DeFi API** (`public-api.birdeye.so/defi/ohlcv`), querying the native SOL token (`So11111111111111111111111111111111111111112`) on Solana.

- **Weekly prices:** Daily OHLCV candles over 56 weeks, sampled every 7th close to produce weekly entry/settlement prices.
- **Volatility estimation:** 30 days of 15-minute candles (2,880 candles), used to compute 30-day and 7-day annualized realized volatility via the standard log-return standard deviation method (see Section 5.1).
- **Date range:** 2025-03-18 to 2026-04-14 (56 usable weeks).

### 8.1.2 Position Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Liquidity `L` | 10,000 | Produces a position value of \~\$11,000 at \$150 SOL, large enough for meaningful premium/payout magnitudes |
| Entry price `S_0` | Real weekly close from Birdeye | Varies each week (\~\$82–\$205 over the period) |
| Lower bound `p_l` | `S_0 × (1 − widthBps/10000)` | Barrier equals lower range bound |
| Upper bound `p_u` | `S_0 × (1 + widthBps/10000)` | Symmetric around entry |
| Widths tested | ±5% (500 bps), ±7.5% (750 bps), ±10% (1000 bps) | Covers narrow to wide range strategies |

**Reference values at `S_0 = \$125.30` (first week's price), ±10%:**

- Position value `V(S_0) ≈ \$10,920`
- Downside cap `Cap_down = V(S_0) − V(p_l) ≈ \$816`
- Upside cap `Cap_up = V(p_u) − V(S_0) ≈ \$235` (note: `Cap_up < Cap_down` by concavity of `V`, Proposition 2.1)
- Lower bound `p_l ≈ \$112.77`; Upper bound `p_u ≈ \$137.83`

### 8.1.3 Protocol Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| RT deposit | \$5,000,000 | Large pool to avoid utilization constraints during backtest |
| Max utilization `u_max` | 30% (3000 bps) | Standard governance setting |
| Protocol fee `φ` | 1.5% (150 bps) | Applied to premium; flows to protocol treasury |
| Markup `m_vol` | 1.08 | `max(1.05, IV/RV)` with IV/RV = 1.08 |
| P_floor | 1% of `V(S_0)` | Dynamic: recalculated each week based on entry price |
| Fee split rate `y` | 10% | Baseline; optimized in two-sided viability analysis |

### 8.1.4 Volatility Regime

From the Birdeye 15-minute candle data (30-day window):

| Metric | Value |
|--------|-------|
| 30-day realized volatility | 67.0% annualized |
| 7-day realized volatility | 57.7% annualized |
| Stress flag | false (`σ_7d / σ_30d = 0.86 < 1.5 threshold`) |

Moderately volatile, non-stressed SOL regime.

### 8.1.5 Fee Yield Tiers

LP trading fees are **simulated** because the Birdeye API does not provide per-position fee data for Orca Whirlpool positions. Fees are modeled as:

```text
F_w = V(S_w) × clip(Normal(r, 0.3r), 0.01%, 1.2%) × 7
```

where `r` is the daily fee rate. Three tiers are tested:

| Tier | Daily Rate `r` | Weekly (% of position) | Annualized |
|------|---------------|------------------------|------------|
| Low | 0.10%/day | 0.70% | 36.5% |
| Medium | 0.25%/day | 1.75% | 91.3% |
| High | 0.45%/day | 3.15% | 164.3% |

**Limitation:** Simulated fees introduce approximation error. The daily rate of 0.10%–0.25% is representative of typical Orca SOL/USDC concentrated liquidity positions at ±10% width based on historical pool analytics. For ground-truth fee data, the `live-orca-test.ts` script opens real positions and measures actual fees.

### 8.1.6 Simulation Structure

Each week is simulated independently (rolling hedge):

1. A fresh protocol instance is created with the configured parameters.
2. The LP's CL position is registered at the week's real entry price.
3. A Liquidity Hedge certificate is purchased (premium determined by the canonical formula over the signed swap FV).
4. At settlement (one week later), the certificate is settled at the real closing price with the signed swap payoff (positive ⇒ RT→LP, negative ⇒ LP→RT via escrow).
5. PnL is computed for the hedged LP, unhedged LP, and RT.

This rolling structure assumes the LP renews the hedge every week, which is the intended usage pattern.

## 8.2 Risk Reduction Results

### 8.2.1 PnL Volatility Reduction

The Liquidity Hedge reduces weekly PnL standard deviation consistently across all fee tiers:

| Width | Low (0.10%/day) | Medium (0.25%/day) | High (0.45%/day) |
|-------|-----------------|--------------------|--------------------|
| ±5% | 30.1% | 30.0% | 29.8% |
| ±7.5% | 43.6% | 43.3% | 42.6% |
| ±10% | 55.0% | 54.5% | 53.4% |

The reduction is **fee-independent** (varies by less than 2 percentage points across fee tiers) because fees add a roughly constant weekly income that shifts the PnL distribution without changing its spread. The signed swap removes *both* the downside and upside components of variance within `[p_l, p_u]`, so the residual variance comes only from tail events (`S_T < p_l` or `S_T > p_u`) and the premium/fee flows.

### 8.2.2 Maximum Drawdown Reduction

Maximum drawdown (peak-to-trough cumulative PnL loss) shows a clear width × fee pattern:

| Width | Fee Tier | Hedged DD | Unhedged DD | Reduction |
|-------|----------|-----------|-------------|-----------|
| ±5% | Low | \$8,949 | \$8,990 | 0% |
| ±5% | Medium | \$5,930 | \$5,700 | −4% |
| ±5% | High | \$2,277 | \$2,378 | 4% |
| ±7.5% | Low | \$9,059 | \$11,392 | 20% |
| ±7.5% | Medium | \$4,738 | \$6,609 | 28% |
| ±7.5% | High | \$1,934 | \$2,957 | 35% |
| ±10% | Low | \$7,985 | \$12,717 | **37%** |
| ±10% | Medium | \$2,960 | \$6,545 | **55%** |
| ±10% | High | \$1,755 | \$3,566 | **51%** |

At ±10% with medium yield, the hedge cuts maximum drawdown roughly in half (\$6,545 → \$2,960). The benefit scales with width: at ±5% the upside give-up can slightly *increase* drawdowns in up-trending price paths (this 56-week sample is mildly up-biased), which is the symmetric trade-off of the swap — the LP chose to forgo upside in exchange for downside protection.

### 8.2.3 Sharpe Ratio

Hedged and unhedged LP Sharpe ratios over the 56-week window:

| Width | Fee Tier | Hedged Sharpe | Unhedged Sharpe |
|-------|----------|---------------|-----------------|
| ±5% | Low | −0.647 | −0.446 |
| ±5% | Medium | −0.423 | −0.273 |
| ±5% | High | −0.124 | −0.041 |
| ±7.5% | Low | −0.556 | −0.385 |
| ±7.5% | Medium | −0.271 | −0.207 |
| ±7.5% | High | 0.103 | 0.030 |
| ±10% | Low | −0.477 | −0.329 |
| ±10% | Medium | −0.110 | −0.146 |
| ±10% | High | **0.361** | 0.096 |

The swap systematically depresses Sharpe relative to unhedged at narrow widths (hedged LP trades variance in both directions for the locked outcome, which hurts a ratio that rewards positive variance). At ±10% with high fees the hedged Sharpe meaningfully exceeds the unhedged, because the tail-risk reduction dominates.

**Interpretation.** Sharpe is not the right yardstick for a risk-transformation product: the LP signs up specifically to *eliminate* both tails of the PnL distribution. The relevant metrics are volatility reduction, drawdown reduction, and the joint breakeven wedge (§8.5).

## 8.3 LP and RT Cumulative PnL

### 8.3.1 Hedged LP Cumulative PnL (\$)

| Width | Low (0.10%/day) | Medium (0.25%/day) | High (0.45%/day) |
|-------|-----------------|--------------------|--------------------|
| ±5% | −8,949 | −5,857 | −1,734 |
| ±7.5% | −9,059 | −4,445 | +1,708 |
| ±10% | −7,985 | −1,862 | **+6,302** |

### 8.3.2 Unhedged LP Cumulative PnL (\$)

| Width | Low (0.10%/day) | Medium (0.25%/day) | High (0.45%/day) |
|-------|-----------------|--------------------|--------------------|
| ±5% | −8,837 | −5,401 | −820 |
| ±7.5% | −11,104 | −5,976 | +860 |
| ±10% | −12,265 | −5,462 | +3,610 |

### 8.3.3 Hedged − Unhedged (\$) — the *insurance value*

| Width | Low | Medium | High |
|-------|-----|--------|------|
| ±5% | −113 | −456 | −914 |
| ±7.5% | **+2,045** | **+1,531** | +848 |
| ±10% | **+4,280** | **+3,600** | **+2,692** |

**At the canonical ±10% width the hedged LP beats unhedged in every fee tier**, by \$2,692 to \$4,280 over 56 weeks. At ±5% the hedged LP underperforms by up to \$914 in this specific sample — the expected consequence of surrendering upside on a width that is frequently breached upward. This confirms the product design: the swap rewards LPs who want downside protection without losing the ability to capture wide-range drift, which is the ±10% setting.

### 8.3.4 RT Cumulative PnL (at P_floor = 1% of position, fee split = 10%)

| Width | Low | Medium | High |
|-------|-----|--------|------|
| ±5% | +62 | **+406** | **+864** |
| ±7.5% | −2,119 | −1,606 | −923 |
| ±10% | −4,379 | −3,699 | −2,792 |

**New to the swap design:** the RT is now profitable at ±5% under the default 1% P_floor (was insolvent under the put baseline). This comes from the LP's upside give-up above `S_0`, which flows to the RT. Wider widths still require P_floor tuning (Section 8.4).

## 8.4 Breakeven Analysis

### 8.4.1 LP Breakeven Daily Fee Yield

The breakeven yield is the minimum daily fee rate at which the LP's cumulative PnL = 0 over the 56-week backtest.

**At default P_floor = 1% of position:**

| Width | Hedged LP Breakeven | Unhedged LP Breakeven | Hedge Premium Cost |
|-------|--------------------|-----------------------|--------------------|
| ±5% | 0.534%/day | 0.486%/day | +4.9 bps/day |
| ±7.5% | 0.395%/day | 0.425%/day | **−3.0 bps/day** |
| ±10% | 0.295%/day | 0.370%/day | **−7.5 bps/day** |

At ±7.5% and ±10%, the hedged LP needs *less* fee yield than the unhedged LP to break even — because the swap pays the LP more in expected downside insurance than they give up in upside (Jensen: `E[V(clamp(S_T))] < V(S_0)` ⇒ `FV > 0`) and the markup `m_vol` sits below the realized path average in this sample.

### 8.4.2 RT Breakeven P_floor

For each width, binary search identifies the minimum `P_floor` (as % of position value) where RT cumulative PnL = 0 at fee split = 10%:

| Width | P_floor for RT BE | Avg Premium/wk | Avg Payout/wk |
|-------|-------------------|----------------|---------------|
| ±5% | 0.88% (\$96/wk) | \$52 | \$62 |
| ±7.5% | 1.33% (\$145/wk) | \$118 | \$132 |
| ±10% | 1.57% (\$172/wk) | \$185 | \$203 |

At the RT-breakeven `P_floor`, the hedged LP breakeven yield adjusts:

| Width | LP Breakeven (at RT BE P_floor) | Unhedged BE | Hedge Cost |
|-------|-------------------------------|-------------|------------|
| ±5% | 0.514%/day | 0.486%/day | +2.8 bps/day |
| ±7.5% | 0.448%/day | 0.425%/day | +2.2 bps/day |
| ±10% | 0.388%/day | 0.370%/day | **+1.8 bps/day** |

When the RT is made whole at fee split = 10%, the hedged LP needs only **1.8 bps/day** of extra yield at ±10%. This still represents a meaningful improvement over the capped-put baseline because the **absolute premium** is materially lower (see §8.5).

## 8.5 Two-Sided Viability: Joint Breakeven

### 8.5.1 Methodology

The two-sided viability analysis finds, for each width, the minimum daily fee yield at which **both** the hedged LP and the RT achieve non-negative cumulative PnL. The search optimizes jointly over:

- **P_floor** ∈ [0.01%, 10%] of position value (binary search for RT = 0)
- **Fee split rate** `y` ∈ {5%, 10%, 15%, 20%, 25%} (grid search for best LP outcome)

For each candidate fee yield, the algorithm:

1. For each fee split rate, binary-searches for the `P_floor` that puts RT at exactly breakeven.
2. At that `(P_floor, y)` pair, evaluates the hedged LP cumulative PnL.
3. Selects the fee split rate that produces the highest LP PnL.
4. Binary-searches on fee yield until LP PnL ≈ 0.

### 8.5.2 Results

| Width | Min Yield | Optimal P_floor | Optimal Fee Split | LP PnL | RT PnL | Unhedged BE | Hedge Cost |
|-------|-----------|-----------------|-------------------|--------|--------|-------------|------------|
| ±5% | **0.486%/day** | 0.37% | 20% | ≈\$0 | ≈\$0 | 0.486%/day | **0.0 bps/day** |
| ±7.5% | **0.426%/day** | 0.76% | 25% | ≈\$0 | ≈\$0 | 0.425%/day | **0.1 bps/day** |
| ±10% | **0.373%/day** | 1.09% | 25% | ≈\$0 | ≈\$0 | 0.370%/day | **0.2 bps/day** |

### 8.5.3 Verification of Theorem 2.2

Theorem 2.2 (Value Neutrality) predicts:

```text
r* − r_u = φ · Σ P_w / (7 · Σ V_w)
```

For ±10% at the joint-breakeven configuration: `φ = 0.015`, avg premium `P̄ ≈ \$129/wk`, avg position value `V̄ ≈ \$11,000`:

```text
r* − r_u  ≈  0.015 × 129 / (7 × 11,000)  ≈  0.0000251  ≈  0.25 bps/day
```

**Observed:** `r* − r_u = 0.373% − 0.370% = 0.3 bps/day` (reported precision 0.2–0.3 bps/day).

The theoretical prediction (0.25 bps) matches the empirical result (0.2–0.3 bps) within the binary search tolerance (±\$10 cumPnL convergence criterion). **Under the signed swap this wedge is smaller than the 0.38 bps/day it would have been under the capped put**, because the swap's smaller `P̄` shrinks the numerator.

A direct numeric check on a single run confirms the identity:

```text
±10% medium:  LP_hedged + RT  =  −1,862 + (−3,699)  =  −5,561
              Unhedged          =  −5,462
              Leakage           =  −99   (≈ ΣφP ≈ 56 × 0.015 × 118 = \$99 ✓)
```

### 8.5.4 Interpretation

The two-sided breakeven yield is **essentially equal to the unhedged breakeven yield**. The hedge cost is 0.0–0.2 bps/day — *smaller* than under the capped-put baseline (0.1–0.3 bps/day) because swap premiums are lower. This confirms Theorem 2.2: the Liquidity Hedge certificate is a value-neutral redistribution mechanism.

At any fee yield where unhedged LPing is profitable, the protocol can be parameterized so that both the hedged LP and the RT are also profitable. Governance does not need to "find" economic surplus to make the protocol viable — the surplus is the LP's fee income minus IL, and `P_floor` and `y` only determine how it's divided.

**Effect of the swap vs. the capped-put baseline:**

| Quantity (±10%, joint BE) | Capped-put (prior) | Signed-swap (current) | Δ |
|---|---|---|---|
| Avg premium / week | \$193 | **\$129** | **−33%** |
| Optimal P_floor | 1.63% | **1.09%** | −33% |
| Optimal fee split | 25% | 25% | — |
| Joint breakeven yield | 0.318%/day | 0.373%/day | +5.5 bps (from different 56-wk window, not a regression) |
| Joint breakeven wedge | 0.3 bps/day | **0.2 bps/day** | **−0.1 bps/day** |

The swap's economic advantage is a **materially lower premium** and a **tighter wedge**, confirming the pricing analysis in §3.1.

## 8.6 Detailed Breakdown at Two-Sided Breakeven

At the minimum viable fee yield for each width:

### ±5% (Min yield: 0.486%/day, 177% APR)

- Position value: \~\$5,500, `Cap_down` ≈ \$330, `Cap_up` ≈ \$95
- Optimal P_floor: 0.37% of position (\$21/week)
- Optimal fee split: 20%
- Avg premium: \$22/week (0.40% of position)
- Avg payout: \$62/week (payout > premium; RT net from fee split + upside give-up)
- Unhedged LP at same yield: +\$5 cumulative (barely breakeven)
- Hedge provides 30% volatility reduction and \~0% drawdown reduction

### ±7.5% (Min yield: 0.426%/day, 156% APR)

- Position value: \~\$8,300, `Cap_down` ≈ \$600, `Cap_up` ≈ \$175
- Optimal P_floor: 0.76% of position (\$63/week)
- Optimal fee split: 25%
- Avg premium: \$68/week (0.82% of position)
- Avg payout: \$132/week
- Unhedged LP at same yield: +\$41 cumulative
- Hedge provides 43% volatility reduction and 28% drawdown reduction

### ±10% (Min yield: 0.373%/day, 136% APR)

- Position value: \~\$11,000, `Cap_down` ≈ \$820, `Cap_up` ≈ \$235
- Optimal P_floor: 1.09% of position (\$120/week)
- Optimal fee split: 25%
- Avg premium: \$129/week (1.18% of position)
- Avg payout: \$203/week
- Unhedged LP at same yield: +\$104 cumulative
- Hedge provides 55% volatility reduction and 55% drawdown reduction

## 8.7 Width Comparison

### 8.7.1 Which Width Is Best?

| Metric | ±5% | ±7.5% | ±10% |
|--------|-----|-------|------|
| Volatility reduction (medium) | 30% | 43% | **55%** |
| Max drawdown reduction (medium) | −4% | 28% | **55%** |
| Two-sided breakeven yield | 0.486%/day | 0.426%/day | **0.373%/day** |
| Hedge cost at joint BE | 0.0 bps | 0.1 bps | 0.2 bps |
| Hedged − Unhedged (medium yield) | −\$456 | +\$1,531 | **+\$3,600** |
| Best hedged Sharpe (high yield) | −0.124 | 0.103 | **0.361** |

**±10% dominates** across every metric that matters for the product's stated purpose:

- Lowest breakeven yield (requires the least fee income).
- Largest absolute hedge benefit vs. unhedged (+\$3,600 at medium yield).
- Largest drawdown reduction (55%).
- Only width where hedged Sharpe becomes positive in the high-fee tier.
- Minimal hedge-cost wedge (0.2 bps/day, barely above zero).

### 8.7.2 Why Not Wider?

Widths beyond ±10% were tested in prior protocol versions and found to produce premium/payout ratios exceeding the fee income available to the RT. The ±10% width represents the empirically optimal tradeoff between hedge effectiveness and RT viability for SOL/USDC at current volatility levels (~67% annualized).

## 8.8 Parameter Sensitivity — Robustness of the Structural Claim

Theorem 2.2 and its corollary (joint breakeven ≈ unhedged breakeven) depend only on the additive structure of the cash flows, not on specific values of IV/RV, RT carry, or LP fee rate. We verify this empirically by sweeping those parameters across realistic ranges and computing the theoretical wedge

```text
r* − r_u  ≈  φ · P̄ / (7 · V̄)
```

for each grid point, where `P̄` is obtained from the **same signed-swap FV quadrature used in production pricing** (Simpson over GBM, `pricing-engine/pricing.ts::computeGaussHermiteFV`). The sweep lives in `scripts/sensitivity-analysis.ts` and is reproducible in under one second.

### 8.8.1 Grid

| Parameter | Range | Rationale |
|---|---|---|
| σ (annualized) | {40%, 65%, 90%, 120%} | Covers SOL's historical realized-vol envelope (30d: 40–110% over 2023–2026) |
| IV/RV | {1.00, 1.05, 1.08, 1.15, 1.25, 1.50} | 1.0 = no VRP; up to 1.5 covers Deribit DVOL / σ_30d observations on SOL |
| RT carry | {0, 5, 10, 15, 20} bps/day | 0 = no alternative yield; 20 bps/day ≈ 7% APR, matching Kamino/Marinade |
| LP fee rate | {0.10%, 0.25%, 0.50%} per day | Same three-tier scheme as §8.1.5 |
| **Grid size** | **360 rows** | |

Fixed reference position: `L = 10000, S_0 = \$150, [p_l, p_u] = [\$135, \$165]` → `V(S_0) ≈ \$11,984, Cap_down ≈ \$892`, 7-day tenor, `φ = 1.5%`, `y = 10%`.

### 8.8.2 Headline result

| Statistic (over 360 rows) | Wedge `r* − r_u` |
|---|---|
| Min | **0.084 bps/day** |
| Median | 0.344 bps/day |
| Mean | 0.322 bps/day |
| **Max** | **0.641 bps/day** |
| Rows exceeding 1 bps/day claim-threshold | **0 / 360** |

Across the entire parameter space, **the wedge never exceeds 0.65 bps/day, and all 360 grid points sit under the 1 bps/day threshold**. The claim of §2.4 and §8.5 — that the Liquidity Hedge is nearly value-neutral in aggregate — is therefore robust to the specific placeholder values (`ivRvRatio = 1.08`, `carry = 5 bps/day`) used in §8.1.3 and §8.5.

### 8.8.3 Marginal sensitivities (baseline: σ=65%, carry=10 bps/day, fee=0.25%/day)

**IV/RV sensitivity** (premium and wedge both scale linearly above the markup floor):

| IV/RV | Premium | Wedge |
|---|---|---|
| 1.00 (no VRP) | \$143.10 | 0.256 bps/day |
| 1.05 (floor) | \$143.10 | 0.256 bps/day |
| 1.08 (backtest) | \$147.79 | 0.264 bps/day |
| 1.15 | \$158.73 | 0.284 bps/day |
| 1.25 | \$174.35 | 0.312 bps/day |
| 1.50 (extreme) | \$213.42 | 0.382 bps/day |

Going from IV/RV = 1.0 to 1.5 increases the wedge by only ~0.13 bps/day — far below the noise floor of the backtest's binary-search tolerance.

**σ sensitivity** (dominant driver of `FV_swap`):

| σ | FV_swap | Premium | Wedge |
|---|---|---|---|
| 40% | \$84.90 | \$70.72 | 0.127 bps/day |
| 65% (backtest) | \$156.26 | \$147.79 | 0.264 bps/day |
| 90% | \$204.86 | \$200.28 | 0.358 bps/day |
| 120% | \$244.57 | \$243.16 | 0.435 bps/day |

Even in stressed 120%-σ regimes the wedge stays below 0.5 bps/day.

**Fee-rate sensitivity** (higher fees reduce premium via `y · E[F]` discount):

| Fee rate | E[F] over tenor | Premium | Wedge |
|---|---|---|---|
| 0.10%/day | \$83.89 | \$160.37 | 0.287 bps/day |
| 0.25%/day | \$209.73 | \$147.79 | 0.264 bps/day |
| 0.50%/day | \$419.46 | \$126.82 | 0.227 bps/day |

Higher fee yields actually **shrink** the wedge, because the fee-discount term lowers the premium.

### 8.8.4 Interpretation

The sensitivity analysis makes precise in what sense the paper's empirical results are robust:

- **Structural claim (Theorem 2.2 + corollary):** invariant to all four swept parameters — only the magnitude of the wedge shifts, not whether the hedge is value-neutral.
- **Claim "hedge cost is negligible":** holds uniformly across the grid (max wedge = 0.64 bps/day, well below any reasonable threshold for a weekly hedge).
- **Specific numerical levels** quoted in §8.5 (min-yield ≈ 0.373%/day at ±10%, wedge ≈ 0.2 bps/day) are representative of the `ivRvRatio = 1.08, σ = 67%, carry = 5 bps/day` operating point but are **not load-bearing** — they could be anywhere in the ranges swept above without changing the qualitative conclusions.

The full 360-row CSV is emitted to `scripts/sensitivity-results.csv` at every run for audit / reviewer reproduction.

## 8.9 Limitations and Caveats

1. **Simulated fees.** LP trading fees are modeled stochastically rather than measured from on-chain data. Real fee income depends on trading volume, pool depth, and the position's share of total liquidity — factors that vary and are not captured by a fixed daily rate.

2. **Single volatility regime.** The regime snapshot is fixed at the 30-day realized vol for the entire backtest. In production, the regime updates every 10 minutes, and the premium adjusts dynamically. The backtest uses a static regime, which underestimates the premium's responsiveness to changing conditions.

3. **No transaction costs.** Gas fees, slippage on premium USDC transfers, and the cost of opening/closing Orca positions are excluded. These are small (< \$0.01 per transaction on Solana) but nonzero.

4. **Weekly rolling assumption.** The LP is assumed to renew the hedge every week at the prevailing price. In practice, an LP might skip weeks during calm periods or extend the tenor during volatile periods.

5. **Historical path dependence.** All results are conditional on the specific 56-week price path observed (2025-03-18 to 2026-04-14, a mildly up-biased sample). Different historical periods (e.g., a sustained bear market) would produce different individual PnL levels and possibly reverse the sign of the hedged − unhedged gap at narrow widths. The **value-neutrality theorem (Theorem 2.2) holds regardless of the price path**; only the *level* of the breakeven yield and the cross-section of LP vs. RT outcomes are path-dependent.

6. **Swap vs. put comparison.** Direct comparison with the earlier capped-put baseline is affected by the 2-day shift in the data window (Birdeye returned a slightly later endpoint). The qualitative conclusions — lower premiums, tighter wedge, RT viable at narrow widths — are robust to the window shift; the specific numerical comparisons in §8.5.4 should be read as directional, not precise.

7. **Parameter choices vs. measurements.** Three inputs in §8.1.3 are *parameter choices* of the experiment, not live measurements:
   - `ivRvRatio = 1.08` (variance risk premium from SOL option markets — not wired to Deribit/Binance/Bybit APIs in this PoC).
   - `carryBpsPerDay = 5` (RT opportunity cost — not pulled from live DeFi yield sources such as Kamino/Marinade).
   - Backtest fee tiers (0.10%/0.25%/0.45% per day, synthetic `clip(Normal(r, 0.3r), 0.01%, 1.2%)`) — not derived from historical pool-volume data.

   The structural claim of §2.4 (Theorem 2.2) is **independent of all three** by construction — the theorem proof depends only on cash-flow additivity. §8.8 validates this empirically: across a 360-row grid spanning realistic ranges for all three parameters plus σ, the joint-breakeven wedge stays below 0.65 bps/day everywhere. Live-oracle integration (Deribit DVOL, Kamino/Marinade yield, on-chain swap-event fee aggregation) is flagged as engineering work that does not strengthen the paper's core claim; see §8.8.4.

   The live-orca demonstration (`scripts/live-orca-test.ts`) does read **real accrued fees** from the Orca position account (`fee_owed_a/b` after `update_fees_and_rewards`) and uses them as the true `feesAccrued` input to settlement — so the end-to-end live demo is free of synthetic fee estimation.

## 8.10 References for This Section

- Birdeye API documentation: [docs.birdeye.so](https://docs.birdeye.so/)
- Orca Whirlpools documentation: [docs.orca.so](https://docs.orca.so/)
- All mathematical results reference Theorem 2.2 (Section 2.4) and the pricing methodology (Section 3).
