# Liquidity Hedge Certificate — Term Sheet

**Template version 0.1-draft — generated per quote by the platform; every field below is
populated automatically and the completed document's SHA-256 hash is shown to the Buyer
before acceptance and anchored on Solana at activation.**

| Field | Value |
|---|---|
| Term Sheet hash | `{sha256}` |
| Master Terms version / hash | `{version}` / `{hash}` |
| Quote ID / payment reference | `{quoteId}` / `{reference}` |
| Quote generated (UTC) / valid until | `{ts}` / `{ts + validity}` |
| Company | Blocksventures Ltd. (BVI BC No. [●]) |
| Buyer wallet | `{buyerPubkey}` |
| Referenced Position (position mint) | `{positionMint}` |
| Pool (Whirlpool address / pair / fee tier) | `{whirlpool}` / `{pair}` / `{feeTier}` |
| Entry Price S₀ | `{S0}` USDC per {tokenA} |
| Corridor `[p_l, p_u]` | `[{pL}, {pU}]` |
| Position liquidity L | `{liquidity}` |
| Tenor / Expiry Time (UTC) | 7 days (604,800 s) / `{expiryTs}` |
| **Premium** | **`{premium}` USDC** |
| **Collateral (= Cap_Up)** | **`{capUp}` USDC** |
| **Total payable now (Premium + Collateral)** | **`{total}` USDC** |
| Maximum payable by Company (Cap_Down) | `{capDown}` USDC |
| Fee split rate y | `{y}` % of trading fees accrued during Tenor |
| Treasury address (pay to) | `{treasury}` |
| Settlement price source | per Master Terms §7.1 |

## Premium breakdown (how your price was computed)

`Premium = max(P_floor, FV · m_vol − y · E[F])`

| Component | Meaning | Value |
|---|---|---|
| FV | fair value of the payoff under a risk-neutral GBM model, σ = `{sigma}`% (30-day realized) | `{fv}` USDC |
| m_vol | volatility markup = max(`{markupFloor}`, IV/RV = `{ivrv}`) | `{mvol}` |
| y · E[F] | your discount for the fee split (expected fees `{ef}` × `{y}`%) | −`{discount}` USDC |
| P_floor | minimum premium | `{pfloor}` USDC |

## What you get (plain language — this section is explanatory, the formulas govern)

Your payoff at expiry is **`Π = V(S₀) − V(clamp(S_T, p_l, p_u))`**, where V is the
standard concentrated-liquidity value function of your position:

- **Price falls below `p_l`** → you receive the maximum: **Cap_Down = `{capDown}` USDC**.
- **Price ends inside `[p_l, p_u]`** → you receive (or pay) the exact mark-to-market
  change of your position value: `V(S₀) − V(S_T)`.
- **Price rises above `p_u`** → you pay the maximum: **Cap_Up = `{capUp}` USDC** — this
  is why you post exactly that amount as Collateral now; you can never owe more.

At settlement you are paid, in USDC:
`Π(S_T) − FeeSplitAmount + Collateral` (never negative).

### Worked examples (computed for THIS position)

| Scenario | S_T | Π | You receive at settlement* |
|---|---|---|---|
| Sharp drop | `{pL × 0.9}` | +`{capDown}` | `{capDown + capUp − feeEst}` |
| Moderate drop | `{S0 × 0.95}` | `{pi1}` | `{pi1 + capUp − feeEst}` |
| Unchanged | `{S0}` | 0 | `{capUp − feeEst}` (Collateral back) |
| Moderate rise | `{S0 × 1.05}` | `{pi2}` (negative) | `{pi2 + capUp − feeEst}` |
| Sharp rise | `{pU × 1.1}` | −`{capUp}` | `{0 − feeEst… floored at 0}` |

\* assuming estimated Fee Split Amount `{feeEst}` USDC; the actual amount is measured
on-chain at expiry.

## Key acknowledgments (checkboxes at purchase; each recorded with timestamp)

- [ ] I have read the Master Hedging Terms `{version}` and this Term Sheet.
- [ ] I have read the Risk Disclosure Statement and accept that I may lose the entire
      Premium and that payments to me depend on Blocksventures Ltd.'s solvency.
- [ ] I understand the Company is **not licensed by any financial regulator**.
- [ ] I meet the eligibility criteria (Master Terms §3), am not in a restricted
      jurisdiction, and am not using tools to disguise my location.
- [ ] I will not modify, close, or transfer the Referenced Position before Expiry.
- [ ] I understand this is not investment advice and the models shown are hypothetical.
