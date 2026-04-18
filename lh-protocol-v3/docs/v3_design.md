# Liquidity Hedge Protocol v3 -- Design Document

---

## 1. Motivation: What v2 Revealed

The v2 protocol was backtested over 51 weeks of real SOL/USDC price data. The simulation exposed five structural problems that v3 addresses.

### 1.1 RT Is Underwater at Narrow Ranges

At +/-5% width, the Risk Taker (RT) had:
- Median weekly return: +7.08%
- Mean weekly return: **-0.62%**
- Maximum drawdown: **-81%**

The positive median masks a catastrophic tail: a handful of severe IL events wipe out months of premium income. The RT's expected value is negative, making the pool economically unviable at +/-5%.

### 1.2 Plain LP Dominates at +/-5%

Unhedged LP at +/-5% produced +3.05% median weekly return with a 0.096 Sharpe ratio, while the hedged LP (corridor, fixed 1.10x) achieved +2.67% median with 0.227 Sharpe. The Sharpe improvement is real, but the premium drag is large enough that many LPs would rationally choose to go unhedged, especially in bull markets.

### 1.3 Two-Part Premium Adds Complexity Without Clear Benefit

The v2 two-part premium (alpha * H * vol_indicator upfront + beta * fees at settlement) had three problems:
- LP cannot reason about the total cost at entry time
- Beta calibration depends on expected weekly fees, which are hard to estimate
- The vol indicator (sigma_7d / sigma_30d) adds a confusing scaling factor

Simulation showed that the two-part model reduced mean returns (+0.64% vs +1.13%) and Sharpe (0.134 vs 0.227) compared to the simpler fixed markup.

### 1.4 Fixed 1.10x Markup Is Arbitrary

The 1.10x markup was chosen as a "reasonable" insurance loading factor, but it has no connection to observable market data. When IV/RV ratios from option markets are available, the protocol should use them directly.

### 1.5 All-or-Nothing Coverage Is Suboptimal

v2 forces the LP to hedge the full natural cap. Many LPs would prefer partial coverage: hedge 50% of the IL risk and retain 50% upside/downside exposure. This reduces premium cost while still providing meaningful protection.

---

## 2. The Five v3 Changes

### Change 1: Drop +/-5% Width

**Rationale:** RT is underwater at +/-5%. The +/-10% width produced the highest Sharpe (0.245) and highest P(+) (86%) across all strategies tested.

**Implementation:** Single template with widthBps = 1000 (+/-10%). The protocol can be extended to other widths in the future if RT economics improve.

### Change 2: Replace Two-Part Premium with Cover Ratio

**Rationale:** LP wants to control *how much* protection to buy, not *when* to pay for it.

**Implementation:** LP chooses coverRatio between 0.25 and 1.00:
- Cap = naturalCap * coverRatio
- Premium = FairValue(Cap) * effectiveMarkup
- Payout = fullCorridorPayout * coverRatio

At coverRatio = 0.50, the LP hedges half the corridor risk at half the premium. The LP retains 50% exposure to IL (and 50% of the IL upside if price recovers within the corridor).

### Change 3: Explainable Pricing (3 Numbers)

**Rationale:** The LP should understand what drives the premium. Three transparent numbers replace the opaque heuristic.

**Implementation:**

    Premium = FairValue * effectiveMarkup * coverRatio

Where:
1. **FairValue** = no-arbitrage expected payout (from Gauss-Hermite quadrature or on-chain heuristic)
2. **effectiveMarkup** = max(markupFloor, IV/RV) -- observable from option markets
3. **coverRatio** = LP's choice (0.25 to 1.00)

The heuristic formula (E[Payout] + C_cap + C_adv + C_rep) still runs on-chain to compute FairValue. The effectiveMarkup is applied multiplicatively on top.

### Change 4: IV/RV-Adaptive Markup with Floor

**Rationale:** Instead of a fixed 1.10x markup, use the implied-to-realized volatility ratio from option markets. When IV > RV, the market prices in higher risk than historical data suggests -- the protocol should charge accordingly. When IV < RV, the markup floor prevents underpricing.

**Implementation:**
- IV sourced from Bybit and Binance SOL options (pick the lower IV for LP-competitive pricing)
- RV = trailing 30-day realized vol from Birdeye OHLCV
- effectiveMarkup = max(1.05, IV/RV)
- markupFloor = 1.05 (configurable per pool)

Typical IV/RV ranges for SOL:
- Calm market: IV/RV ~ 1.02-1.10
- Elevated vol: IV/RV ~ 1.15-1.40
- Stress: IV/RV ~ 1.50+

### Change 5: Fee Split (Replaces Performance Fee)

**Rationale:** RT needs additional revenue beyond premiums to survive tail events. Instead of a performance fee on excess LP profits, the fee-split model gives the RT a percentage of the LP's trading fees at settlement. This provides predictable, diversified income for the RT that is correlated with LP activity (not with claims), and reduces the LP's upfront premium cost.

**Implementation:**

At purchase time (premium discount):

    Premium = FairValue * effectiveMarkup * coverRatio - feeSplitRate * E[weeklyFees]

At settlement time (fee income to RT):

    rtFeeIncome = actualFees * feeSplitRate

Where:
- feeSplitRate = 10% (configurable per pool)
- expectedDailyFee = 0.5%/day (calibratable from on-chain data)
- E[weeklyFees] = V0 * expectedDailyFee * 7

The fee split flows into pool reserves at settlement, increasing share value for RTs. The premium discount at purchase reflects the expected fee split, creating a lower upfront cost for the LP.

---

## 3. Parameter Table

| Parameter | Symbol | Default | Range | Location |
|---|---|---|---|---|
| Markup floor | markupFloor | 1.05 | [1.01, 2.00] | PoolState |
| Cover ratio | coverRatio | 0.50 | [0.25, 1.00] | BuyCertParams |
| Barrier depth | barrierDepthBps | 1000 (10%) | [100, 3000] | TemplateConfig |
| Fee split rate | feeSplitRate | 0.10 (10%) | [0, 0.50] | PoolState |
| Expected daily fee | expectedDailyFee | 0.005 (0.5%) | [0.001, 0.02] | PoolState |
| Max utilization | uMaxBps | 3000 (30%) | [1000, 5000] | PoolState |
| Protocol fee | protocolFeeBps | 150 (1.5%) | [0, 500] | PoolState |
| Width | widthBps | 1000 (+/-10%) | [500, 2000] | TemplateConfig |
| Tenor | tenorSeconds | 604800 (7d) | [86400, 2592000] | TemplateConfig |
| Premium floor | premiumFloorUsdc | 50000 ($0.05) | [0, 10^9] | TemplateConfig |
| Premium ceiling | premiumCeilingUsdc | 500000000 ($500) | [10^6, 10^12] | TemplateConfig |

---

## 4. Pricing Formula

### What the LP Sees

The LP receives a quote with 3 transparent numbers plus a fee discount:

    Premium = $9.08  (= $11.75 FV * 1.05 markup * 1.00 cover - 0.10 * $34.50 fee discount)

Or with partial coverage:

    Premium = $2.71   (= $11.75 FV * 1.05 markup * 0.50 cover - 0.10 * $34.50 fee discount)

The LP can independently verify each component:
1. **Fair value ($11.75):** Derived from GBM-based Gauss-Hermite quadrature at current sigma. Deterministic, reproducible.
2. **Markup (1.05x):** max(1.05, IV/RV). The LP can check SOL option IV on Bybit/Binance and RV from any price feed.
3. **Cover ratio (0.50):** The LP's own choice.
4. **Fee discount ($3.45):** feeSplitRate * E[weeklyFees]. Reflects the RT's expected fee income from the split.

### On-Chain Heuristic (Fair Value Proxy)

The on-chain program computes fair value using the same heuristic as v1/v2:

    FairValue = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling)

Where:
- E[Payout] = Cap * p_hit * severity / PPM^2
- p_hit = min(PPM, 900000 * sigma * sqrt(T) / width)
- C_cap = Cap * (U_after / PPM)^2 / 5
- C_adv = Cap / 10 if stress, else 0
- C_rep = Cap * carry_bps * tenor_sec / BPS / 100 / 86400
- severity is auto-calibrated so heuristic tracks GH fair value

The effectiveMarkup is then applied multiplicatively, and the fee discount subtracted:

    Premium = FairValue * effectiveMarkup - feeSplitRate * E[weeklyFees]

The cover ratio is already baked into Cap = naturalCap * coverRatio, so the cap-proportional components (E[Payout], C_cap, etc.) scale naturally. The premium is floored at $0.05 (50,000 micro-USDC) to ensure the RT always receives a minimum income.

### Barrier Computation

v3 decouples barrier from width:

    barrier = S0 * (1 - barrierDepthBps / 10000)

Default: barrierDepthBps = 1000 => barrier = S0 * 0.90

This allows the protocol to offer different barrier depths independently of the CL position width. For example, a +/-10% position could use a 15% barrier depth (barrier at S0 * 0.85), providing deeper protection but at higher premium.

---

## 5. RT Revenue Model

### Revenue Sources

The RT earns from three channels in v3:

1. **Premium income:** When LP buys a certificate, the premium (minus protocol fee) flows into pool reserves. This increases the NAV per share, benefiting all RTs proportionally.

2. **Fee split income:** At settlement, the RT receives feeSplitRate% (default 10%) of the LP's actual trading fees accrued during the tenor. This provides income that is correlated with LP activity, not with claims.

3. **Share price appreciation:** The NAV-based share pricing means that net positive income (premiums + fee split - payouts) increases the share price over time.

### Revenue Decomposition

For a single certificate with natural_cap N, cover_ratio c, effective_markup m, fair_value FV, and expected weekly fees F:

    Premium received by pool = (FV * m * c - feeSplitRate * F) * (1 - protocolFeeBps/10000)

    Fee split at settlement = actualFees * feeSplitRate

    Expected payout = FV * c  (by definition of fair value)

    RT total weekly income = premium_income + fee_split_income - claims

Where:
  premium_income = premium * 0.985 (after 1.5% protocol fee)
  fee_split_income = actual_fees * fee_split_rate
  claims = corridor_payout * cover_ratio

At m = 1.05 (the minimum), with typical fees:

    premium_income = (FV * 1.05 * c - 0.10 * F) * 0.985
    fee_split_income = actualFees * 0.10
    net = premium_income + fee_split_income - FV * c

The fee split provides income diversification:
- In good weeks (no claims): RT earns premium + fee split
- In bad weeks (claims > 0): fee split partially offsets the loss
- Fee split income is correlated with LP fee income, not with claims

### Why v3 Is Better for RT Than v2

1. **No +/-5% width:** Removes the product that was systematically unprofitable for RT.
2. **Fee split:** Diversified revenue stream from LP trading fees, partially offsetting tail losses.
3. **Cover ratio < 1.0:** When LPs choose partial coverage, the scaled cap is smaller, reducing the pool's tail risk exposure per certificate.
4. **IV/RV markup:** In stressed markets (high IV/RV), the premium rises automatically, giving the RT more cushion against elevated payout risk.

---

## 6. Comparison to Options and Perps

### vs. OTC Put Spreads

| Dimension | Corridor Certificate | Put Spread |
|---|---|---|
| Payoff shape | Matches CL loss curve exactly (concave) | Linear between strikes (basis risk) |
| Gamma risk | Zero (payoff = actual CL loss) | Nonzero (linear approx of concave loss) |
| Settlement | Automated on-chain | Manual or OTC (counterparty risk) |
| Collateral | Pool-backed, on-chain reserves | OTC counterparty credit |
| Customization | coverRatio, barrierDepth | Strike selection |
| Liquidity | Protocol pool | OTC desk availability |

The fundamental advantage: the corridor certificate's payoff function is V(S0) - V(max(ST, B)), which exactly matches the CL position's loss. A put spread's linear payoff systematically overhedges small moves and underhedges large moves.

### vs. Perpetual Futures Delta Hedge

| Dimension | Corridor Certificate | Perp Hedge |
|---|---|---|
| Cost structure | Fixed upfront premium | Variable borrow rate (55-130% APY) |
| Gamma error | Zero | Significant, especially at tight ranges |
| Rebalancing | None (single tx) | Weekly or daily (gas + slippage) |
| Funding risk | None | Highly variable funding rates |
| Coverage | Defined corridor | Full delta (but not gamma) |
| Capital efficiency | Premium = ~5-10% of cap | 100% margin + borrow |

v2 simulation showed the corridor wins 73-84% of weeks vs perps at +/-5%, and 49-61% at +/-10% (where gamma error is smaller). At realistic borrow rates (80% APY), the perp hedge has negative mean return at +/-5%.

### vs. Insurance / Structured Products

| Dimension | Corridor Certificate | Traditional Insurance |
|---|---|---|
| Markup | 5-20% above fair value | 20-40% loading factor |
| Transparency | 3-number formula | Opaque actuarial tables |
| Settlement | Permissionless, oracle-based | Claims process, adjudication |
| Duration | 7 days (renewable) | 30-365 days |
| Customization | coverRatio, barrier depth | Limited standardized products |
| Counterparty | On-chain pool with reserves | Insurance company balance sheet |

---

## 7. Implementation Notes

### Barrier Depth vs. Width

In v2, the barrier was always derived from the CL position width: barrier = S0 * (1 - widthBps/10000). This coupled the barrier to the LP's Orca position range, which is correct for "full corridor" coverage.

In v3, barrierDepthBps is a template parameter that can differ from widthBps. This decoupling enables:
- **Shallow barriers** (barrierDepthBps < widthBps): cheaper premium, covers only partial corridor
- **Matching barriers** (barrierDepthBps = widthBps): same as v2, full corridor coverage
- **Deep barriers** (barrierDepthBps > widthBps): extends beyond the tick range, covers some below-range loss

The default (1000 = 10%) matches the default width (1000 = +/-10%), preserving v2 behavior.

### Cover Ratio Mechanics

The cover ratio scales three things symmetrically:
1. **Cap:** Pool's maximum liability = naturalCap * coverRatio
2. **Premium:** Cost to LP = FV(scaledCap) * effectiveMarkup
3. **Payout:** Settlement amount = fullCorridorPayout * coverRatio

This means the RT's risk per certificate decreases linearly with coverRatio, while the LP retains (1 - coverRatio) exposure to IL.

At coverRatio = 0.50:
- LP pays ~50% of the full-coverage premium
- LP receives ~50% of the full corridor payout
- LP retains ~50% IL exposure
- RT reserves ~50% of the capital needed for full coverage

### Fee Split Settlement

The fee split is computed at settlement time:

    rtFeeIncome = actualFees * feeSplitRate

This means:
- If LP earned $100 in fees with feeSplitRate = 0.10: rtFeeIncome = $10.00
- If LP earned $20 in fees: rtFeeIncome = $2.00
- If LP earned $0 in fees: rtFeeIncome = $0 (no fee split)
- The rtFeeIncome flows into pool reserves, increasing RT share value
- LP net position: fees * (1 - feeSplitRate) - premium + payout

### Severity Derivation from effectiveMarkup

In v2, severity was calibrated to make the heuristic equal markup * fairValue. In v3, severity is calibrated to make the heuristic equal fairValue (no markup), because the markup is applied multiplicatively afterward.

This simplifies the calibration: severity targets the unloaded fair value, and the effectiveMarkup is purely a scaling factor on top. The separation makes it clearer what drives pricing: severity captures the risk model, markup captures the market loading.

### State Machine (Unchanged from v2)

- PositionState.status: LOCKED (1) -> RELEASED (2) | CLOSED (3)
- CertificateState.state: CREATED (0) -> ACTIVE (1) -> SETTLED (2) | EXPIRED (3)

The position must be LOCKED to purchase a certificate. The certificate must be ACTIVE to settle. Settlement transitions to SETTLED (if payout > 0) or EXPIRED (if payout = 0). Position protection is released on settlement.

### On-Chain Considerations

The v3 changes are backward-compatible with the Anchor program structure:
- PoolState gains two new fields (feeSplitRate, expectedDailyFee) -- requires account migration or new init
- TemplateConfig gains barrierDepthBps -- requires account migration
- CertificateState gains coverRatio, drops premiumUpfrontUsdc/premiumDeferredUsdc/betaFraction/feesAccruedUsdc/settlementPremiumUsdc -- net smaller account size
- The effectiveMarkup is applied in the pricing instruction after computing the heuristic
- Fee split (rtFeeIncome) is computed in the settle instruction and added to reserves
