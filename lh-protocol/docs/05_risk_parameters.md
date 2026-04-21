# 5. Risk Parameters

## 5.1 Volatility Estimation

### 5.1.1 Realized Volatility

The protocol estimates realized volatility (RV) from historical price data at two horizons:

**30-day RV (`sigmaPpm`).** The primary volatility input for pricing. Computed as the annualized standard deviation of daily log-returns over a trailing 30-day window:

```
r_t = ln(S_t / S_{t-1})

sigma_30d = sqrt(365) * std(r_1, r_2, ..., r_30)
```

The annualization factor `sqrt(365)` converts daily volatility to annual volatility under the assumption of independent daily returns.

**7-day RV (`sigma7dPpm`).** A shorter-horizon volatility estimate that captures recent market dynamics. Used for stress detection (Section 5.4):

```
sigma_7d = sqrt(365) * std(r_1, r_2, ..., r_7)
```

Both values are stored in PPM (parts per million): `sigmaPpm = sigma * 1,000,000`. For example, `sigma = 65%` annualized is stored as `sigmaPpm = 650,000`.

### 5.1.2 Annualization

The choice of annualization factor affects all downstream computations. The protocol uses `sqrt(365)` (calendar days) rather than `sqrt(252)` (trading days) because cryptocurrency markets trade continuously. This distinction matters:

```
sqrt(365) = 19.105
sqrt(252) = 15.875
```

Using `sqrt(252)` would understate annualized volatility by approximately 17%, leading to systematic premium underpricing. The protocol's SECONDS_PER_YEAR constant (`365 * 86,400 = 31,536,000`) is consistent with calendar-day annualization.

### 5.1.3 Volatility Clamping

The regime update enforces valid bounds:

```
sigma_clamped = clamp(sigma_raw, 1,000 PPM, 5,000,000 PPM)
             = clamp(sigma_raw, 0.1%, 500%)
```

The lower bound prevents division-by-zero in the hit probability calculation. The upper bound prevents unrealistic values from corrupting pricing during data feed errors.

## 5.2 Implied-to-Realized Volatility Ratio

### 5.2.1 Variance Risk Premium Theory

The variance risk premium (VRP) is the difference between the risk-neutral expected variance (implied from option prices) and the physical expected variance (estimated from historical data) [14, 15]:

```
VRP = E^Q[sigma^2] - E^P[sigma^2] ~ IV^2 - RV^2
```

Empirically, `VRP > 0` in most equity and crypto markets, reflecting the compensation demanded by volatility sellers. This manifests as `IV/RV > 1` on average.

For the protocol, the IV/RV ratio serves as a natural markup: it captures the market's assessment of forward-looking volatility risk beyond what historical data reveals.

### 5.2.2 Data Sources

The protocol sources implied volatility from SOL option markets on two exchanges:

- **Bybit**: SOL perpetual options, ATM implied volatility for the nearest weekly expiry.
- **Binance**: SOL options (when available), ATM implied volatility.

The protocol selects the **lower** IV from available sources:

```
IV_effective = min(IV_Binance, IV_Bybit)
```

This LP-competitive pricing rule ensures the premium is based on the cheaper hedge available in the broader market. If the protocol priced above both exchanges, rational LPs would hedge directly in option markets instead.

### 5.2.3 Handling Missing Data

When IV data is unavailable (exchange API outage, insufficient option liquidity, or no listed SOL options):

```
if no IV data available:
  m_vol = markupFloor  (default: 1.05)
else:
  m_vol = max(markupFloor, IV_effective / RV)
```

The markup floor provides a lower bound that ensures the RT always earns at least a 5% markup over the actuarially fair price, regardless of data availability.

## 5.3 Effective Markup

The effective markup `m_vol` is the central risk adjustment in the premium formula:

```
m_vol = max(markupFloor, IV/RV)
```

**Interpretation:**

| IV/RV | m_vol (floor=1.05) | Market Condition |
|-------|-------------------|------------------|
| 0.90 | 1.05 | Low fear, IV < RV (rare) |
| 1.00 | 1.05 | Neutral, floor binds |
| 1.05 | 1.05 | At floor |
| 1.15 | 1.15 | Elevated risk premium |
| 1.40 | 1.40 | High fear / stress |

Typical SOL IV/RV ratios range from 0.95 to 1.50, with a long-run average around 1.08--1.15 based on Bybit option market data (2023--2025).

## 5.4 Regime Detection

### 5.4.1 Stress Flag

The stress flag indicates periods of elevated market risk. It is set by the off-chain risk service based on:

1. **Volatility spike**: `sigma_7d > 1.5 * sigma_30d` (short-term vol significantly exceeds longer-term).
2. **Absolute threshold**: `sigma_30d > 100%` annualized.
3. **External signals**: Crypto Fear & Greed Index < 20, major protocol exploits, regulatory events.

When the stress flag is active, the adverse selection charge `C_adv = Cap/10` is added to the heuristic FV. This 10% surcharge compensates the RT for the heightened probability of large payouts during stress periods.

### 5.4.2 Carry Cost

The daily carry cost (`carryBpsPerDay`) reflects the opportunity cost of RT capital. It is denominated in basis points per day and used in the replication cost component:

```
C_rep = Cap * carry_bps * tenor_seconds / BPS / (100 * 86,400)
```

Typical values: 3--10 BPS/day, corresponding to 11--37% annualized. This should reflect prevailing USDC lending rates on platforms such as Aave, Compound, or Kamino.

The carry cost is clamped to `[0, 1000]` BPS/day to prevent extreme values from corrupting pricing.

### 5.4.3 Regime Snapshot Freshness

The regime snapshot has a maximum age of `REGIME_MAX_AGE_S = 900` seconds (15 minutes). Certificate purchases are rejected if the regime is stale:

```
isRegimeFresh = (now - regime.updatedAt) <= 900
```

This ensures pricing reflects current market conditions. The off-chain risk service should update the regime at least every 10 minutes.

## 5.5 Severity Calibration

### 5.5.1 Role of Severity

The severity parameter (`severityPpm`) controls the expected payout magnitude in the heuristic FV proxy. It answers: "Given that the price enters the active range `[p_l, p_u]`, what fraction of `Cap_down` is the expected net payout?"

```
E[Payout] = Cap * p_hit * severity / PPM^2
```

Higher severity means the heuristic assumes larger payouts, producing higher FV and thus higher premiums.

### 5.5.2 Calibration Algorithm

The severity is calibrated at each regime update to minimize the gap between the heuristic proxy and the numerical FV:

```
function calibrateSeverityForPool(sigma, template, pool, stress, carry):
  cap_ref = $100 (scale-invariant reference)
  
  // Compute hit probability
  p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
  
  // Compute non-severity costs
  C_cap = cap_ref * (U_after)^2 / 5
  C_adv = cap_ref / 10 if stress, else 0
  C_rep = cap_ref * carry * tenor / BPS / (100 * 86400)
  non_severity = C_cap + C_adv + C_rep
  
  // Geometric FV proxy: average swap payoff in the active range
  FV_target = cap_ref * p_hit * (width/2) / PPM
  
  // Solve for severity
  ePayout = FV_target - non_severity
  severity = ePayout * PPM^2 / (cap_ref * p_hit)
  
  return clamp(severity, 1, PPM)
```

The calibration uses a scale-invariant reference cap (\$100) so the severity depends only on volatility, width, tenor, and pool utilization -- not on the absolute size of any particular certificate.

### 5.5.3 Feedback Loop

After calibration, a bounded error-correction loop adjusts severity based on the gap between the previous expected and observed values:

```
function applySeverityFeedback(current, expected, realized, gain=0.20, maxStep=0.025):
  errorRatio = (realized - expected) / max(1, expected)
  rawStep = errorRatio * gain * current
  boundedStep = clamp(rawStep, -maxStep * PPM, +maxStep * PPM)
  return clamp(current + boundedStep, 1, PPM)
```

**Parameters:**
- `gain = 200,000 PPM` (20%): Controls the speed of adjustment.
- `maxStep = 25,000 PPM` (2.5%): Bounds the maximum per-step change.

**Convergence.** The bounded step ensures stability: even if a single observation has large error, severity changes by at most 2.5% per update. Over multiple updates (spaced ~10 minutes apart), the severity converges to the level where the heuristic matches the numerical FV within the gain * maxStep tolerance (~0.5%).

### 5.5.4 Severity Lifecycle

```
1. Bootstrap: severity = 380,000 PPM (38%)
   (Pre-calibrated for sigma=65%, T=7d, width=+/-10%)

2. First regime update:
   calibrateSeverityForPool() computes fresh severity from current params

3. Subsequent updates:
   applySeverityFeedback() applies bounded correction
   
4. Steady state:
   severity oscillates within ~2.5% of the optimal value
```

## 5.6 Summary of Risk Parameters

| Parameter | Symbol | Default | Unit | Source |
|-----------|--------|---------|------|--------|
| 30-day realized vol | `sigma` | -- | PPM | OHLCV data |
| 7-day realized vol | `sigma_7d` | -- | PPM | OHLCV data |
| IV/RV ratio | `IV/RV` | 1.08 | ratio | Bybit/Binance options |
| Markup floor | `markupFloor` | 1.05 | ratio | Governance |
| Stress flag | `stressFlag` | false | boolean | Risk service |
| Carry cost | `carry` | 5 | BPS/day | DeFi lending rates |
| Severity | `severity` | 380,000 | PPM | Auto-calibrated |
| Regime max age | `REGIME_MAX_AGE_S` | 900 | seconds | Protocol constant |

## 5.7 References for This Section

- [14] Carr, P. & Wu, L. (2009). "Variance Risk Premiums." *Review of Financial Studies*, 22(3), 1311--1341.
- [15] Bollerslev, T., Tauchen, G., & Zhou, H. (2009). "Expected Stock Returns and Variance Risk Premia." *Review of Financial Studies*, 22(11), 4463--4492.
