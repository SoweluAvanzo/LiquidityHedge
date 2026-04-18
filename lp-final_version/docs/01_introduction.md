# 1. Introduction

## 1.1 Problem Statement

Concentrated liquidity (CL) positions on automated market makers (AMMs) such as Uniswap V3 [1] and Orca Whirlpools offer capital-efficient fee income by concentrating liquidity within a specified price range `[p_l, p_u]`. However, this concentration amplifies impermanent loss (IL): when the spot price `S` moves away from the entry price `S_0`, the position's value diverges from a simple buy-and-hold portfolio. For a CL position on SOL/USDC, a 10% downward move in SOL price can produce IL exceeding 2--3% of position value, rapidly eroding fee income.

The magnitude of IL in CL positions is governed by the *value function* `V(S)`, a concave, piecewise function of `S` parameterized by the liquidity `L` and the price bounds `[p_l, p_u]` (see Section 2.1.2 for the full derivation). The concavity of `V(S)` implies that IL accelerates as price deviates from `S_0`, creating a non-linear risk profile that is poorly hedged by linear instruments.

### 1.1.1 Quantifying the Problem

Consider a representative LP deploying $1,000 of liquidity in a SOL/USDC position with +/-10% range at `S_0 = $150`. Under a geometric Brownian motion (GBM) model with `sigma = 65%` annualized volatility (a conservative estimate for SOL), the expected impermanent loss over 7 days is approximately 0.8--1.2% of position value ($8--$12). Meanwhile, the expected fee income for a +/-10% range in the SOL/USDC 1% fee tier pool is approximately 0.5% per day, or $35 per week. The risk is that IL can spike to 4--6% of position value ($40--$60) in high-volatility weeks, completely eliminating fee income and generating net losses.

This asymmetry -- moderate expected fee income versus fat-tailed IL risk -- is the core problem the Liquidity Hedge Protocol addresses.

### 1.1.2 Scale and Relevance

As of 2025, concentrated liquidity AMMs hold over $5B in total value locked (TVL) across Ethereum, Solana, and other chains. The SOL/USDC pair alone sees daily volumes exceeding $100M on Orca Whirlpools. Despite this scale, no purpose-built IL hedging instrument exists for CL positions. LPs must either accept the unhedged risk, over-collateralize their positions, or resort to the imperfect hedges described below.

## 1.2 Existing Hedging Approaches and Their Limitations

### 1.2.1 Put Spread Strategies

A liquidity provider (LP) can purchase a put option at strike `K_1 = S_0` and sell a put at `K_2 < K_1` to create a put spread. While this provides bounded downside protection, it suffers from **basis risk**: the linear payoff `max(0, K_1 - S_T) - max(0, K_2 - S_T)` does not match the concave CL loss profile `V(S_0) - V(S_T)`. The hedge underperforms in the interior of the range and overpays at the boundaries. Additionally, standardized option strikes rarely align with the LP's specific `p_l` and `p_u`, creating further mismatch.

### 1.2.2 Perpetual Delta Hedging

An LP can continuously delta-hedge the SOL exposure of their CL position using perpetual futures. The instantaneous delta is:

```
delta(S) = dV/dS = L / sqrt(p_u)    for p_l < S < p_u
```

This requires continuous rebalancing. The key limitations are:

- **Gamma error**: The CL position has non-zero gamma `d^2V/dS^2 = -L / (4 * S^(3/2))` within the range. Discrete rebalancing introduces tracking error proportional to `gamma * (deltaS)^2`.
- **Funding cost**: Perpetual futures charge periodic funding rates (typically 10--30% annualized for SOL), which compound over the hedge horizon and can exceed the fee income the position generates.
- **Operational complexity**: Maintaining a perpetual position requires margin management, liquidation monitoring, and cross-venue infrastructure.

### 1.2.3 Insurance-Style Products

Protocol-level insurance pools (e.g., Nexus Mutual, InsurAce) provide coverage against smart contract exploits but do not address IL. Their actuarial models are not designed for the continuous, market-driven risk of CL positions.

### 1.2.4 Summary of Limitations

| Approach | Basis Risk | Cost Structure | Operational Burden |
|----------|-----------|----------------|-------------------|
| Put spread | High (linear vs concave) | Fixed premium | Low (one trade) |
| Delta hedge | Medium (gamma error) | Variable (funding) | High (continuous) |
| Insurance pool | Total (wrong risk) | Fixed premium | Low |
| **Corridor cert** | **Zero** | **Fixed premium** | **Low (one trade)** |

The corridor certificate occupies a unique position: zero basis risk (by matching the CL payoff exactly), fixed upfront cost (a single premium payment), and minimal operational burden (a single purchase transaction with permissionless settlement).

## 1.3 Protocol Overview

The **Liquidity Hedge Protocol** introduces a purpose-built hedging instrument: the **corridor certificate**, a cash-settled derivative whose payoff exactly replicates the impermanent loss of a concentrated liquidity position within its price range.

The protocol involves three parties:

1. **Liquidity Provider (LP)**: Opens a CL position on an Orca Whirlpool (SOL/USDC), escrows the position NFT in the protocol, and purchases a corridor certificate.
2. **Risk Taker (RT)**: Deposits USDC into a protection pool, earning premiums and a share of LP trading fees in exchange for underwriting the corridor payoff.
3. **Protocol**: Mediates the interaction, computes fair premiums, manages the escrow and settlement lifecycle, and collects a treasury fee.

The certificate lifecycle proceeds as follows:

1. The LP registers and locks their CL position (NFT escrow).
2. The LP purchases a corridor certificate, paying a premium to the pool.
3. At expiry (default: 7 days), anyone can trigger permissionless settlement.
4. The settlement oracle (Pyth) provides the terminal price `S_T`.
5. The corridor payoff `PI(S_T)` is computed and disbursed to the LP from the pool.
6. The RT receives a share of the LP's accrued trading fees.
7. The position NFT is released back to the LP.

## 1.4 Key Innovation

The core innovation is the **corridor payoff function**:

```
PI(S_T) = min(Cap, max(0, V(S_0) - V(max(S_T, B))))
```

where `V(S)` is the exact CL value function, `B = p_l` is the barrier (equal to the lower bound of the CL position), and `Cap = V(S_0) - V(B)` is the natural cap.

This payoff has three critical properties:

1. **Exact IL replication**: Within the corridor `[B, S_0]`, the payoff `PI(S_T) = V(S_0) - V(S_T)` matches the IL exactly -- there is zero basis risk.
2. **Bounded liability**: The payout is capped at `Cap = V(S_0) - V(B)`, ensuring the RT's maximum loss per certificate is known at issuance.
3. **Natural alignment**: The barrier `B` equals the LP's lower price bound `p_l`, so the hedge covers exactly the range where the LP has concentrated liquidity. Below `B`, the LP's position is fully converted to SOL and IL is capped by the CL mechanics themselves.

This design eliminates the basis risk inherent in put spreads and the operational complexity of delta hedging, while providing full coverage (no cover ratio) within the LP's active range.

## 1.5 Premium Design Philosophy

The canonical premium formula balances three objectives:

1. **Actuarial fairness**: The fair value (FV) component prices the expected corridor payoff under risk-neutral GBM, ensuring the premium reflects the true cost of the hedge.
2. **Market-consistency**: The variance risk premium markup `m_vol = max(markupFloor, IV/RV)` aligns the premium with observed option market prices, preventing arbitrage between the protocol and external hedging venues.
3. **Participation constraints**: The premium floor `P_floor` and fee split `y * E[F]` ensure both sides of the market are incentivized to participate -- the RT earns above-opportunity-cost returns, while the LP receives a fee discount that reduces the net hedging cost.

The resulting formula:

```
Premium = max(P_floor, FV * m_vol - y * E[F])
```

is detailed in Section 3.

## 1.6 Product Specification: Cash-Settled Capped Corridor Certificate

The protocol implements **Product A**: a single hedge product on the SOL/USDC pair with a single USDC-denominated protection pool. The product parameters are:

| Parameter | Value | Description |
|-----------|-------|-------------|
| Pair | SOL/USDC | Underlying asset pair |
| Width | +/-10% (`widthBps = 1000`) | CL position range |
| Tenor | 7 days (604,800 s) | Certificate duration |
| Settlement | Cash-settled in USDC | Payout denomination |
| Payoff | Proportional (not binary) | Tracks actual IL |
| Coverage | Full (no cover ratio) | 100% of IL within range |
| Barrier | `B = p_l = S_0 * 0.90` | Equals lower CL bound |
| Cap | `Cap = V(S_0) - V(B)` | Natural cap from CL value |

## 1.7 Design Rationale for Product Parameters

The +/-10% width and 7-day tenor were selected based on extensive backtesting (52 weekly periods across varying volatility regimes):

- **+/-10% width** achieves the highest Risk Taker Sharpe ratio (0.245) and the highest probability of positive RT return per certificate (86%) across tested widths (+/-5%, +/-10%, +/-15%, +/-20%).
- **+/-5% width** is RT-insolvent: the narrower range produces high hit rates and severe payouts, resulting in negative mean RT returns and -81% maximum drawdown.
- **+/-15% width** requires premiums exceeding expected fee income (beta > 1.0), making the hedge uneconomical for LPs.
- **7-day tenor** balances hedging frequency against transaction costs. Weekly rolling hedges provide sufficient protection while keeping premium costs manageable relative to fee income.

## 1.8 Document Roadmap

- **Section 2**: Mathematical foundations -- CL value function, GBM model, corridor payoff derivation.
- **Section 3**: Pricing methodology -- fair value computation, canonical premium formula, heuristic proxy.
- **Section 4**: Protocol mechanism -- pool design, certificate lifecycle, fee split.
- **Section 5**: Risk parameters -- volatility estimation, variance risk premium, severity calibration.
- **Section 6**: Implementation -- on-chain architecture, state management, integer arithmetic.
- **Section 7**: References -- full bibliography.

## 1.9 References for This Section

- [1] Adams, H. et al. (2021). "Uniswap v3 Core."
- [2] Lambert, G. et al. (2021). "Uniswap V3 LP Tokens as Perpetual Put and Call Options."
- [3] Loesch, S. et al. (2021). "Impermanent Loss in Uniswap V3."
- [8] Black, F. & Scholes, M. (1973). "The Pricing of Options and Corporate Liabilities."
