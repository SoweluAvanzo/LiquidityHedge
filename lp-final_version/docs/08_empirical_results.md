# 8. Empirical Results

This section documents the backtesting methodology and results obtained by running the corridor hedge protocol over real SOL/USDC historical price data sourced from the Birdeye API.

## 8.1 Experimental Setup

### 8.1.1 Data Source

All price data is sourced from the **Birdeye DeFi API** (`public-api.birdeye.so/defi/ohlcv`), querying the native SOL token (`So11111111111111111111111111111111111111112`) on Solana.

- **Weekly prices:** Daily OHLCV candles over 56+ weeks, sampled every 7th close to produce weekly entry/settlement prices.
- **Volatility estimation:** 30 days of 15-minute candles (2,880 candles), used to compute 30-day and 7-day annualized realized volatility via the standard log-return standard deviation method (see Section 5.1).
- **Date range:** 2025-03-16 to 2026-04-12 (56 usable weeks).

### 8.1.2 Position Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Liquidity `L` | 10,000 | Produces a position value of ~$11,000 at $150 SOL, large enough for meaningful premium/payout magnitudes |
| Entry price `S_0` | Real weekly close from Birdeye | Varies each week ($82–$189 over the period) |
| Lower bound `p_l` | `S_0 × (1 − widthBps/10000)` | Barrier equals lower range bound |
| Upper bound `p_u` | `S_0 × (1 + widthBps/10000)` | Symmetric around entry |
| Widths tested | ±5% (500 bps), ±7.5% (750 bps), ±10% (1000 bps) | Covers narrow to wide range strategies |

**Reference values at `S_0 = $126.10` (first week's price), ±10%:**
- Position value `V(S_0) ≈ $10,990`
- Natural cap `Cap ≈ $818`
- Lower bound / barrier `p_l = $113.49`

### 8.1.3 Protocol Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| RT deposit | $5,000,000 | Large pool to avoid utilization constraints during backtest |
| Max utilization `u_max` | 30% (3000 bps) | Standard governance setting |
| Protocol fee `φ` | 1.5% (150 bps) | Applied to premium; flows to protocol treasury |
| Markup `m_vol` | 1.08 | `max(1.05, IV/RV)` with IV/RV = 1.08 |
| P_floor | 1% of `V(S_0)` | Dynamic: recalculated each week based on entry price |
| Fee split rate `y` | 10% | Baseline; optimized in two-sided viability analysis |

### 8.1.4 Volatility Regime

From the Birdeye 15-minute candle data (30-day window):

| Metric | Value |
|--------|-------|
| 30-day realized volatility | 64.7% annualized |
| 7-day realized volatility | 68.3% annualized |
| Stress flag | false (`σ_7d / σ_30d = 1.06 < 1.5 threshold`) |

This represents a moderately volatile but non-stressed environment for SOL.

### 8.1.5 Fee Yield Tiers

LP trading fees are **simulated** because the Birdeye API does not provide per-position fee data for Orca Whirlpool positions. Fees are modeled as:

```
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
3. A corridor certificate is purchased (premium determined by the canonical formula).
4. At settlement (one week later), the certificate is settled at the real closing price.
5. PnL is computed for the hedged LP, unhedged LP, and RT.

This rolling structure assumes the LP renews the hedge every week, which is the intended usage pattern.

## 8.2 Risk Reduction Results

### 8.2.1 PnL Volatility Reduction

The corridor hedge reduces weekly PnL standard deviation consistently across all fee tiers:

| Width | Volatility Reduction |
|-------|---------------------|
| ±5% | 26.4%–26.9% |
| ±7.5% | 40.7%–41.4% |
| ±10% | 53.6%–55.5% |

The reduction is **fee-independent** (varies by less than 2 percentage points across fee tiers) because fees add a roughly constant weekly income that shifts the PnL distribution without changing its spread. The hedge removes the IL component of variance.

### 8.2.2 Maximum Drawdown Reduction

Maximum drawdown (peak-to-trough cumulative PnL loss) is reduced substantially, with the strongest effect at wider widths and medium fee yields:

| Width | Fee Tier | Hedged DD | Unhedged DD | Reduction |
|-------|----------|-----------|-------------|-----------|
| ±5% | Medium | $3,197 | $4,161 | 23% |
| ±7.5% | Medium | $2,368 | $5,280 | 55% |
| ±10% | Medium | $1,279 | $6,129 | **79%** |
| ±10% | Low | $3,293 | $10,111 | **67%** |
| ±10% | High | $928 | $2,988 | **69%** |

At ±10% with medium yield, the hedge reduces maximum drawdown from $6,129 to $1,279 — a **79% reduction**. This is the hedge's primary value proposition: tail risk containment.

### 8.2.3 Sharpe Ratio Improvement

Risk-adjusted returns improve at moderate to high fee yields:

| Width | Fee Tier | Hedged Sharpe | Unhedged Sharpe | Improvement |
|-------|----------|---------------|-----------------|-------------|
| ±5% | High | 0.092 | 0.045 | +0.047 |
| ±7.5% | High | 0.361 | 0.117 | +0.244 |
| ±10% | High | **0.757** | 0.182 | **+0.575** |
| ±10% | Medium | **0.236** | -0.087 | **+0.323** |
| ±10% | Low | -0.169 | -0.288 | +0.119 |

At ±10% with medium yield, the hedged LP achieves a positive Sharpe (0.236) where the unhedged LP is negative (-0.087). At high yield, the hedged LP's Sharpe of 0.757 represents strong risk-adjusted performance.

## 8.3 LP and RT Cumulative PnL

### 8.3.1 Hedged LP Cumulative PnL ($)

| Width | Low (0.10%/day) | Medium (0.25%/day) | High (0.45%/day) |
|-------|-----------------|--------------------|--------------------|
| ±5% | -5,996 | -2,909 | +1,208 |
| ±7.5% | -5,166 | -559 | +5,585 |
| ±10% | -2,538 | **+3,576** | **+11,727** |

### 8.3.2 Unhedged LP Cumulative PnL ($)

| Width | Low (0.10%/day) | Medium (0.25%/day) | High (0.45%/day) |
|-------|-----------------|--------------------|--------------------|
| ±5% | -7,206 | -3,776 | +799 |
| ±7.5% | -8,876 | -3,757 | +3,069 |
| ±10% | -9,713 | -2,920 | +6,138 |

At ±10% with medium yield, the hedged LP earns **+$3,576** while the unhedged LP loses **-$2,920** — a $6,496 difference attributable to the corridor payouts compensating IL events.

### 8.3.3 RT Cumulative PnL (at P_floor = 1% of position, fee split = 10%)

| Width | Low | Medium | High |
|-------|-----|--------|------|
| ±5% | -1,260 | -917 | -460 |
| ±7.5% | -3,785 | -3,273 | -2,590 |
| ±10% | -7,274 | -6,594 | -5,689 |

At the default 1% P_floor, the RT is underwater across all configurations. This motivates the parameter optimization in Section 8.4.

## 8.4 Breakeven Analysis

### 8.4.1 LP Breakeven Daily Fee Yield

The breakeven yield is the minimum daily fee rate at which cumulative PnL = 0 over the 56-week backtest.

**At default P_floor = 1% of position:**

| Width | Hedged LP Breakeven | Unhedged LP Breakeven | Hedge Saves |
|-------|--------------------|-----------------------|-------------|
| ±5% | 0.391%/day | 0.415%/day | 2.4 bps/day |
| ±7.5% | 0.268%/day | 0.360%/day | 9.2 bps/day |
| ±10% | 0.163%/day | 0.315%/day | **15.2 bps/day** |

At the default 1% P_floor (where RT is not viable), the hedged LP's breakeven is *lower* than the unhedged LP's — the corridor payouts more than compensate the premium cost.

### 8.4.2 RT Breakeven P_floor

For each width, binary search identifies the minimum P_floor (as % of position value) where RT cumulative PnL = 0 (at fee split = 10%):

| Width | P_floor for RT BE | Premium/week | Payout/week |
|-------|-------------------|-------------|-------------|
| ±5% | 1.28% ($141/wk) | $76 | $85 |
| ±7.5% | 1.67% ($183/wk) | $148 | $161 |
| ±10% | 2.01% ($221/wk) | $238 | $254 |

At the RT-breakeven P_floor, the hedged LP breakeven yield adjusts:

| Width | LP Breakeven (at RT BE P_floor) | Unhedged BE | Hedge Cost |
|-------|-------------------------------|-------------|------------|
| ±5% | 0.437%/day | 0.415%/day | +2.1 bps/day |
| ±7.5% | 0.376%/day | 0.360%/day | +1.7 bps/day |
| ±10% | 0.327%/day | 0.315%/day | **+1.2 bps/day** |

When the RT is made whole, the hedged LP needs only **1.2 bps/day** more yield than the unhedged LP at ±10%. This additional cost represents the protocol fee wedge.

## 8.5 Two-Sided Viability: Joint Breakeven

### 8.5.1 Methodology

The two-sided viability analysis finds, for each width, the minimum daily fee yield at which **both** the hedged LP and the RT achieve non-negative cumulative PnL. The search optimizes jointly over:

- **P_floor** ∈ [0.01%, 10%] of position value (binary search for RT = 0)
- **Fee split rate** `y` ∈ {5%, 10%, 15%, 20%, 25%} (grid search for best LP outcome)

For each candidate fee yield, the algorithm:
1. For each fee split rate, binary-searches for the P_floor that puts RT at exactly breakeven.
2. At that (P_floor, y) pair, evaluates the hedged LP cumulative PnL.
3. Selects the fee split rate that produces the highest LP PnL.
4. Binary-searches on fee yield until LP PnL ≈ 0.

### 8.5.2 Results

| Width | Min Yield | Optimal P_floor | Optimal Fee Split | LP PnL | RT PnL | Unhedged BE | Hedge Cost |
|-------|-----------|----------------|-------------------|--------|--------|-------------|------------|
| ±5% | **0.416%/day** | 0.73% | 25% | ≈$0 | ≈$0 | 0.415%/day | 0.1 bps/day |
| ±7.5% | **0.363%/day** | 1.33% | 20% | ≈$0 | ≈$0 | 0.360%/day | 0.3 bps/day |
| ±10% | **0.318%/day** | 1.63% | 25% | ≈$0 | ≈$0 | 0.315%/day | 0.3 bps/day |

### 8.5.3 Verification of Theorem 2.2

Theorem 2.2 (Value Neutrality) predicts:

```
r* − r_u = φ Σ P_w / (7 · Σ V_w)
```

For ±10%: `φ = 0.015`, avg premium `P̄ ≈ $193/wk`, avg position value `V̄ ≈ $11,000`:

```
r* − r_u = 0.015 × 193 / (7 × 11,000) = 0.000038 = 0.38 bps/day
```

**Observed:** `r* − r_u = 0.318% − 0.315% = 0.3 bps/day`

The theoretical prediction (0.38 bps) matches the empirical result (0.3 bps) within the binary search tolerance (±$10 cumPnL convergence criterion).

### 8.5.4 Interpretation

The two-sided breakeven yield is essentially equal to the unhedged breakeven yield. The hedge cost is 0.1–0.3 bps/day — **economically negligible**. This confirms Theorem 2.2: the corridor certificate is a value-neutral redistribution mechanism. At any fee yield where unhedged LPing is profitable, the protocol can be parameterized so that both the hedged LP and the RT are also profitable.

The practical implication: governance does not need to "find" economic surplus to make the protocol viable. The surplus already exists (it is the LP's fee income minus IL). The governance parameters `P_floor` and `y` merely determine how that surplus is divided.

## 8.6 Detailed Breakdown at Two-Sided Breakeven

At the minimum viable fee yield for each width:

### ±5% (Min yield: 0.416%/day, 152% APR)

- Position value: ~$5,500, Cap: ~$330
- Optimal P_floor: 0.73% of position ($40/week)
- Optimal fee split: 25%
- Avg premium: $43/week (0.78% of position)
- Avg payout: $85/week (payout > premium; fee split income closes the gap for RT)
- Unhedged LP at same yield: +$29 cumulative (just barely profitable)
- Hedge provides 27% volatility reduction and 23% drawdown reduction

### ±7.5% (Min yield: 0.363%/day, 132% APR)

- Position value: ~$8,300, Cap: ~$600
- Optimal P_floor: 1.33% of position ($111/week)
- Optimal fee split: 20%
- Avg premium: $119/week (1.43% of position)
- Avg payout: $161/week
- Unhedged LP at same yield: +$87 cumulative
- Hedge provides 41% volatility reduction and 55% drawdown reduction

### ±10% (Min yield: 0.318%/day, 116% APR)

- Position value: ~$11,000, Cap: ~$818
- Optimal P_floor: 1.63% of position ($180/week)
- Optimal fee split: 25%
- Avg premium: $193/week (1.75% of position)
- Avg payout: $254/week
- Unhedged LP at same yield: +$152 cumulative
- Hedge provides 55% volatility reduction and 79% drawdown reduction

## 8.7 Width Comparison

### 8.7.1 Which Width Is Best?

| Metric | ±5% | ±7.5% | ±10% |
|--------|-----|-------|------|
| Volatility reduction | 27% | 41% | **55%** |
| Max drawdown reduction (med) | 23% | 55% | **79%** |
| Two-sided breakeven yield | 0.416%/day | 0.363%/day | **0.318%/day** |
| Hedge cost at RT viability | 0.1 bps | 0.3 bps | 0.3 bps |
| Best hedged Sharpe (high yield) | 0.092 | 0.361 | **0.757** |

**±10% dominates** across all metrics:
- Lowest breakeven yield (requires the least fee income)
- Highest risk reduction (55% vol, 79% drawdown)
- Best risk-adjusted returns (0.757 Sharpe at high yield)
- Nearly identical hedge cost to narrower widths (0.3 bps/day)

This is because wider positions have more concentrated IL within the range, making the corridor payoff more valuable relative to the premium.

### 8.7.2 Why Not Wider?

Widths beyond ±10% were tested in prior protocol versions (v2) and found to produce premium/payout ratios exceeding the fee income available to the RT. The ±10% width represents the empirically optimal tradeoff between hedge effectiveness and RT viability for SOL/USDC at current volatility levels (~65% annualized).

## 8.8 Limitations and Caveats

1. **Simulated fees.** LP trading fees are modeled stochastically rather than measured from on-chain data. Real fee income depends on trading volume, pool depth, and the position's share of total liquidity — factors that vary and are not captured by a fixed daily rate.

2. **Single volatility regime.** The regime snapshot is fixed at the 30-day realized vol for the entire backtest. In production, the regime updates every 10 minutes, and the premium adjusts dynamically. The backtest uses a static regime, which underestimates the premium's responsiveness to changing conditions.

3. **No transaction costs.** Gas fees, slippage on premium USDC transfers, and the cost of opening/closing Orca positions are excluded. These are small (< $0.01 per transaction on Solana) but nonzero.

4. **Weekly rolling assumption.** The LP is assumed to renew the hedge every week at the prevailing price. In practice, an LP might skip weeks during calm periods or extend the tenor during volatile periods.

5. **Historical dependence.** All results are conditional on the specific 56-week price path observed. Different historical periods (e.g., a sustained bull or bear market) would produce different breakeven yields and Sharpe ratios. The value-neutrality theorem (Theorem 2.2) holds regardless of the price path; only the *level* of the breakeven yield is path-dependent.

## 8.9 References for This Section

- Birdeye API documentation: https://docs.birdeye.so/
- Orca Whirlpools documentation: https://docs.orca.so/
- All mathematical results reference Theorem 2.2 (Section 2.4) and the pricing methodology (Section 3).
