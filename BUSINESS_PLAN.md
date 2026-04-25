# Liquidity Hedge Protocol — Business Plan

A commercialisation plan for the Liquidity Hedge (LH) Protocol presented at DLT2026, structured along Bill Aulet's *Disciplined Entrepreneurship* (DE) 24-step framework. Built around the BVI corporate structure already in place.

---

## 1. Executive Summary

**Product.** Two complementary offerings on top of the LH Protocol:

- **LH Protocol**: a smart-contract-based bilateral risk-transfer mechanism for concentrated-liquidity (CL) positions on Solana DEXes (Orca Whirlpools at MVP, Raydium CLMM and Meteora DLMM in the roadmap). The protocol issues *signed-swap certificates* that transfer the mark-to-market variability of a CL position from the LP to a Risk Taker (RT) underwriting a USDC pool. Value-neutrality is formally proven (Theorem 1 in the paper) and verified empirically.
- **LH Analytics**: a SaaS-style dashboard and routing layer that lets LPs monitor positions, simulate hedge cost vs. expected risk reduction, and rank pools by *risk-adjusted realised yield*. Drives traffic into the protocol; monetised independently via subscription tiers.

**Revenue model.** Protocol-treasury fee `phi` on premiums (1–2% of `P_w`), set conservatively to keep the breakeven wedge below 1 bp/day per the paper's evaluation. Analytics: tiered SaaS (free / pro / institutional). Optional B2B white-label of the routing engine for LP DAOs and treasury managers.

**Beachhead market.** Professional and semi-professional CLMM liquidity providers on Solana: funds, market-making firms running CL positions, and DAO treasuries with active LPs. Solana is selected over EVM because (a) Orca is a Solana protocol and the PoC already integrates with it, and (b) Solana DEX volumes have for several months exceeded Ethereum DEX volumes, with Orca and Raydium being the dominant CLMM venues.

**Headline financial honesty.** The paper's own evaluation shows that, on the SOL/USDC 0.04% pool at recent regimes, the measured pool yield falls 0.14–0.18 percentage points/day below the two-sided breakeven `r*`. **The protocol is therefore not economically viable on the most-traded SOL/USDC pool today.** The business plan centres on pool selection, on volatile / new-listing pools where realised yield clears `r*`, and on the Analytics product whose value proposition does not depend on any particular pool clearing breakeven.

---

## 2. Problem Statement (DE Step 1: Market Segmentation Foundation)

### 2.1 The pain

CLMM liquidity provision exposes the LP to *impermanent loss* (IL): a structural, well-documented loss caused by adverse price movement against the deposited token ratio. In CLMMs (Uniswap v3 family, Orca Whirlpools, Raydium CLMM, Meteora DLMM) the IL is amplified by range concentration: tighter ranges earn more fees per dollar of capital but deplete faster on price moves, often producing negative net P&L despite positive fee income.

**Empirical magnitude (cited where I can do so reliably):**

- Loesch, Hindman, Welch & Vesely (2021), *Impermanent Loss in Uniswap v3*, analysed Uniswap v3 positions and found that a majority of liquidity providers had returns *worse than HODL* over the studied window: fees did not compensate IL. The exact percentage varies by window; the qualitative finding has been replicated.
- Hasbrouck, Rivera & Saleh (2025, *Management Science*) formalises a CLMM LP position as analogous to selling a covered call at *intrinsic* (not market) value, structurally underpriced relative to what an option market would charge for the same risk. This is the theoretical reason LPs lose to IL on average.
- Independent dashboards (DefiLlama, Revert Finance) routinely show that for many active CLMM pools the cumulative-fees-vs-IL ratio is below 1 over rolling windows.

The qualitative point, that CLMM LPs often net-lose to IL despite earning fees, is robust across studies. Specific figures must be dated and sourced when used in pitches.

### 2.2 What the market currently offers (and why it is inadequate)

| Solution | Limitation |
|---|---|
| On-chain options (Lyra, Premia, OPYN) | Liquid only for ETH and BTC; absent for the long tail of pairs where IL is most acute. Hedging a CLMM position needs a portfolio of options, not a single contract. |
| Power perpetuals (Squeeth) | Squeeth was discontinued by Opyn; the category has not produced lasting alternatives. Schaller (2022) explicitly called this out. |
| Perpetual futures (Hyperliquid, dYdX, Aevo) | Linear payouts; do not match the concave CL value function. Hedging IL with perps is approximate at best, requires continuous rebalancing, and consumes funding. |
| Active liquidity managers (Gamma, Arrakis, Sommelier) | Manage the position (rebalance, range-shift); they do not *transfer* the risk. The LP still bears the IL. |
| Bumper Finance | Downside protection on the underlying asset price, not on the CL position equity curve. |
| Bancor v2 IL protection (legacy) | The product failed; recursive token-emission-funded IL insurance proved economically unsustainable. |

**The structural gap:** no protocol offers a *single contract*, *priced consistently with the CLMM payoff shape*, that *transfers IL risk* to a counterparty. The LH Protocol fills exactly this gap.

### 2.3 Why now

1. **Solana CLMM volume growth**: Solana DEX volume has, on multiple recent months, exceeded Ethereum DEX volume. Orca Whirlpools and Raydium CLMM together represent the bulk of Solana CL TVL.
2. **Institutional LP entry**: market-making firms and DAO treasuries are increasingly LPing on CLMMs to capture fees, and they need risk-management tooling.
3. **Regulatory clarity in BVI**: the BVI VASP Act 2022 and subsequent guidance give DeFi service operators a clear (if demanding) registration path.

---

## 3. The Solution

### 3.1 LH Protocol (the on-chain product)

A smart-contract protocol on Solana that issues weekly *Liquidity Hedge certificates*. Each certificate transfers the LP's mark-to-market variability inside the CL range to a counterparty (Risk Taker) in exchange for a premium. The economic engine is the canonical premium formula

```
P_w = max(P_floor,  FV_w * m_vol_w  -  y * F_w(r))
```

with fair-value `FV_w` computed by quadrature over GBM dynamics (paper Section 4.2). Theorem 1 establishes value-neutrality: the only ecosystem leakage is the governance-set treasury fee `phi * P_w`. The empirical wedge `r* - r_u` stays below 1 basis point per day across a 360-row sensitivity grid.

### 3.2 LH Analytics (the application layer)

A web dashboard that lets users:

- **Monitor active CL positions** across supported DEXes (TVL, in-range time, accrued fees, IL vs. HODL).
- **Pre-trade hedge simulator**: given an intended position size, range, and tenor, return the projected `P_w`, the empirical wedge, and the expected risk-reduction metrics (vol reduction, MaxDD reduction, CVaR(5%) reduction).
- **Pool ranking** by *risk-adjusted realised yield*: `r_position(w) - r*(w)`. Pools where this margin is positive are the ones where the protocol economically clears.
- **One-click hedge** routing into the protocol when the user decides to act.

The Analytics is *the demand-side funnel for the protocol* and a *standalone product* whose subscription revenue does not depend on the protocol's economic viability on any specific pool.

---

## 4. Market Sizing (DE Steps 1 to 4)

### 4.1 Segmentation

Three dimensions: chain (Solana / Ethereum / L2s), LP profile (retail / semi-pro / institutional), use-case (yield-farming / market-making / treasury management).

### 4.2 Beachhead market

**Beachhead: Solana CLMM LPs running positions ≥ $50k notional, with semi-professional or institutional sophistication.**

Why this beachhead (DE Step 2 criteria):

- **Well-funded customer**: positions of this size produce premium revenue in the $50–500/week range per certificate, enough to cover the protocol fee meaningfully.
- **Reachable**: this audience reads CLMM-focused content, uses Revert Finance or DefiLlama, and can be reached through paid X (Twitter) ads, Solana ecosystem newsletters, and direct outreach to known LP teams.
- **Compelling reason to buy**: the paper's empirical results show positive risk-reduction on every width tested. Loss-averse LPs (treasuries, mandate-bound funds) value drawdown and CVaR reduction more than mean-return optimisation.
- **Whole product available with help of partners**: data via Birdeye/Helius, on-chain ops via Orca, custody via Fireblocks/MPC partners or self-custody.
- **Strong competitive position**: no other protocol issues a single-contract CLMM-shaped hedge.
- **Market consistent with values, passions, goals** of a research-driven team.

### 4.3 TAM (beachhead)

Order-of-magnitude estimate, deliberately conservative:

- Solana CLMM TVL across Orca Whirlpools and Raydium CLMM: low billions USD (verify on DefiLlama at pitch day).
- Assume 30–40% of TVL is in pools/widths where the protocol could clear breakeven (volatile pairs, narrow ranges, new listings).
- Assume 20% of that is provided by LPs in the target sophistication band.
- Average premium of 0.5%/week (≈26%/year) of position notional, of which we capture `phi = 1.5%` as treasury fee.

If addressable Solana CLMM capital is ~$200M and LPs purchase certificates on ~10% of capital weekly, premium volume is ~$10M/year; protocol revenue at `phi = 1.5%` is **~$150k/year**: a beachhead, not a billion-dollar TAM.

This is *deliberately small*. Per Aulet, the beachhead must be *winnable*, not enormous. The follow-on TAM (Step 14) is the multi-chain extension.

### 4.4 Follow-on markets (DE Step 14)

In order:

1. **Raydium CLMM and Meteora DLMM** on Solana (~2 to 3x beachhead TAM, similar customer profile).
2. **Uniswap v3 / v4 on Ethereum and L2s** (Arbitrum, Base, Optimism). Same protocol math, different deployment. Expands TAM by ~10x given Uniswap's scale.
3. **B2B / white-label** to LP-management protocols (Arrakis, Gamma, Kamino, Drift) who want to offer hedged-LP vaults to their users.
4. **CFMM-adjacent venues**: Curve LP positions (different value function; protocol math generalises with rederivation).

---

## 5. Persona, Use Case, Product Spec, Value Proposition (DE Steps 5 to 8)

### 5.1 Persona

*Marco, 34, quant trader at a $30M crypto fund based in Lisbon. Runs CLMM positions on Solana, sizes typically $100k–$2M per position, range ±5–10%. Uses Revert Finance and an internal P&L tracker. Has tried hedging with perps and found the deltas too noisy to manage. His pain is the un-hedgeable, range-dependent IL on stablecoin-volatile pairs in volatile regimes. He would pay 1–2% of position notional per week to convert IL variance into a known cost.*

### 5.2 Full life cycle use case

1. Marco opens a CL position on Orca SOL/USDC at ±7.5% for $250k.
2. Logs into LH Analytics, sees the projected weekly premium ($45) and the projected risk-reduction (32% vol, 43% MaxDD, 20% CVaR(5%)).
3. Clicks "Hedge", signs the transaction, certificate is minted.
4. Position runs for 7 days; LH Analytics shows the unhedged vs hedged P&L in real time.
5. At expiry, the certificate auto-settles. Marco receives a payout (if price moved adversely) or pays the surrendered upside (if it moved in his favour, within the range), with net effect bounded by the caps.
6. Marco renews the certificate for the next week, or closes the position.

### 5.3 High-level product spec

**Protocol**:
- Smart contracts on Solana (Anchor program), beachhead deployment Orca-only.
- Risk Taker pool: USDC vault, SPL share token, NAV pricing.
- Single product template: ±10% width, 7-day tenor, on the validated SOL/USDC and (post-launch) on a curated set of approved pools.
- Off-chain regime/pricing services: sigma from Birdeye, IV/RV from Binance, concentration `c(w)` from on-chain Orca state.
- Settlement triggered by Certificate Lifecycle Manager (off-chain bot, signs on-chain settlement).

**Analytics**:
- Web app, Wallet-Connect login.
- Read-only access to user positions across Orca / Raydium / Meteora.
- Pre-trade simulator (free), real-time P&L dashboard (Pro tier), API access (Institutional tier).

### 5.4 Quantified value proposition (DE Step 8)

For a $250k position at ±7.5% on a high-fee pool that *clears the breakeven*:

- Without hedge: paper's 52-week SOL backtest shows ~$5k MaxDD, ~$2.4k CVaR(5%) per year.
- With hedge: ~$2.9k MaxDD (43% reduction), ~$1.7k CVaR(5%) (20% reduction).
- Annual premium cost: ~$2.3k at 0.5%/week.
- Net trade for Marco: pay ~$2.3k per year in premium to remove ~$2k of expected drawdown variance and ~$0.7k of tail loss. Worth it for any LP whose internal cost of drawdown exceeds 1x.

This is honest: the value proposition is *risk reduction at fair price, not free alpha*. The paper itself is explicit about this.

---

## 6. Competitor Analysis (DE Step 11)

### 6.1 Direct competitors (CLMM IL hedging)

| Competitor | Mechanism | Strengths | Weaknesses vs. LH |
|---|---|---|---|
| **Active LP managers** (Gamma, Arrakis, Sommelier, Steer) | Algorithmic rebalancing of LP ranges | Established, integrated with multiple DEXes, real TVL ($100M+ each) | Do not *transfer* risk; LP still bears IL. Often shift the problem rather than hedge it. |
| **Bumper Finance** (Ethereum) | Downside protection on asset price | Live product, has TVL | Hedges spot price, not CL position equity curve. Different math. |
| **Y2K Finance** | Tail-risk insurance (depeg protection) | Live | Targets stablecoin depegs, not IL. |
| **Bancor v2 (legacy)** | IL insurance funded by recursive token emissions | First-mover in IL coverage | Failed; recursive incentives proved unsustainable. The LH value-neutrality theorem directly addresses why this failure mode is structurally avoided. |

### 6.2 Substitute competitors (alternative hedges)

| Substitute | Mechanism | Why LP might choose this | Why LH is better |
|---|---|---|---|
| **Lyra, Premia, OPYN** (on-chain options) | Buy puts/calls to hedge | Liquid for ETH/BTC | Not available for the long tail of pairs where IL bites hardest. Need a *portfolio* of options, not one contract. |
| **Hyperliquid, dYdX, Aevo** (perps) | Sell perp to hedge delta | Highly liquid, low fees | Linear payout does not match concave V; need continuous rebalancing; funding cost. |
| **Manual rebalancing** | LP closes/reopens position on price moves | Free | Time-intensive; gas costs; does not capture the asymmetric payoff. |

### 6.3 Indirect competitors (analytics)

| Competitor | Strengths | Weaknesses vs. LH Analytics |
|---|---|---|
| **DefiLlama** | Industry-standard TVL/yield data | No CL-specific tooling, no per-position simulation. |
| **Revert Finance** | Best-in-class CL position analytics for Uniswap v3 | EVM only; no hedge integration; no Solana coverage. |
| **APY.vision** | Multi-chain LP analytics | No risk-adjusted yield; no hedge simulator. |
| **Gauntlet** | Risk analytics for protocols | B2B-only, focused on protocol parameters not LP positions. |

**Competitive positioning:** LH is the *only* offering that combines (a) a rigorously priced single-contract IL hedge for CLMMs and (b) the analytics layer to help LPs select pools where the hedge clears breakeven. The combination is the moat.

### 6.4 Customer's purchase priorities

For Marco (the persona): (1) capital efficiency, (2) risk transfer (not just risk transformation), (3) simplicity (single contract, not portfolio), (4) transparency of cost. LH ranks above competitors on (2), (3), (4); roughly equal on (1).

---

## 7. Decision Making Unit and Customer Acquisition (DE Steps 12, 13, 18, 19)

### 7.1 DMU

For semi-pro / institutional LPs:

- **Champion**: head trader / quant
- **End user**: same trader
- **Economic buyer**: fund CIO / DAO treasury committee
- **Influencers**: research providers (Delphi Digital, Messari), CLMM-focused KOLs

### 7.2 COCA (Cost of Customer Acquisition) assumptions

- Top-of-funnel: Solana ecosystem newsletters, X paid promotion, sponsored content with LP-focused publications. Estimated CPM and conversion rate require real testing; placeholder: $20k/month for 50–100 qualified leads.
- Conversion to first hedge: free Analytics tier; 5% of signups convert to a paid hedge within 30 days.
- COCA per active hedger: estimated $200–500 in early phase, dropping with referral and content compounding.

### 7.3 LTV (DE Step 17) assumptions

- Average position size: $250k.
- Hedges per year: 30 (renewals every week, with attrition).
- Average premium per hedge: $45 (per paper backtest at ±7.5%, $250k position).
- Protocol fee at 1.5%: $20/hedge x 30 = $600/year per active LP from the protocol.
- Plus Analytics Pro subscription if applicable: $50–200/month so $600–2400/year.
- Customer lifetime: assume 18 months (DeFi attrition is high; this is conservative but not pessimistic).
- LTV per customer: $1,800 (protocol-only, conservative) to $5,400 (protocol + Analytics Pro).

### 7.4 LTV/COCA test

LTV ($1.8k–5.4k) / COCA ($200–500) = ratio of 4x to 27x. Aulet's heuristic is 3x minimum. The economics survive *if and only if* the assumptions about hedge volume per LP and pool clearing breakeven hold. Both are testable in months 4–9 of the roadmap.

---

## 8. Pricing & Business Model (DE Steps 15 to 16)

### 8.1 Three revenue lines

1. **Protocol treasury fee `phi`** on each premium. Default 1.5% (the paper's empirical setting). Sustainable per Theorem 1: the wedge stays below 1 bp/day.
2. **Analytics SaaS**:
   - Free tier: read-only dashboard, basic metrics.
   - Pro tier ($79/month): pre-trade simulator, real-time P&L, hedge alerts.
   - Institutional ($999+/month): API access, custom pool universe, white-label reports.
3. **B2B / white-label**: percentage of premiums on hedges originated through partner platforms (Arrakis, Gamma, etc.). Negotiated per partnership, target 30–50% of `phi` shared.

### 8.2 Why this pricing is defensible

- **Treasury fee**: the paper *proves* the wedge is bounded by `phi`, so a 1.5% fee is provably minimal-impact at the LP level.
- **Analytics**: comparable to existing tools (DefiLlama Pro, Revert) which charge in the $50–500/month range for institutional access.
- **B2B**: the 30–50% split is consistent with industry norms in DeFi rev-share deals (e.g., aggregator/router splits with underlying protocols).

---

## 9. Legal Structure: BVI Considerations

Working from the BVI entity already in place; this is high-level orientation, not legal advice (a BVI counsel review is required before launch).

### 9.1 Why BVI works for this product

- **No corporate income tax** on BVI Business Companies (BCs); only annual licence fees.
- **VASP regime under VASP Act 2022**: clearly defined registration path with the Financial Services Commission (FSC) for businesses providing VA services. Registration is required if the business engages in VA exchange, transfer, custody, or related services on behalf of others.
- **Token issuances**: BVI does not have a securities-token-specific framework, but securities laws apply where applicable. Utility / governance tokens are commonly structured through BVI BCs with offshore opinion letters.

### 9.2 Recommended structure

- **BVI BC (operating)**: owns IP, employs core team via service agreements with onshore-resident contractors.
- **BVI Foundation Company**: issues governance/utility token (if any) and holds protocol upgrade keys; common pattern for DeFi protocols.
- **Service company in low-tax jurisdiction** (e.g., UAE FZE or Cayman LLC): develops smart contracts under contract for the foundation; insulates IP and regulatory exposure.
- **VASP registration in BVI**: required if the BVI entity directly intermediates user transactions; can be avoided by ensuring the on-chain protocol is non-custodial (the paper's description supports this: the pool is non-custodial in the smart-contract sense).

### 9.3 Risk and compliance items

- KYC/AML on Risk Takers: even a non-custodial protocol may need KYC on RTs above thresholds, depending on the FSC's interpretation. Sanction-list screening on all wallet interactions is operationally feasible via Chainalysis or TRM Labs.
- Marketing restrictions in the EU (MiCA), UK, and US: no marketing into the US without a registered offering or appropriate exemption. Geofence the front-end.
- Recurring annual obligations: BVI BC annual fee, FSC reporting if VASP-registered, audit if size triggers it.

---

## 10. Honest Profitability Assessment

### 10.1 Where it makes money

1. **High-volatility, high-fee pools** where measured `r_position` exceeds `r*`. The paper finds this is *not* the case for SOL/USDC 0.04% at recent regimes, but is plausible for narrower-tier pools, new listings, and depeg-vulnerable stable pairs.
2. **Treasury and fund customers** with explicit risk-management mandates that require IL hedging. This audience is willing to pay above-fair premiums, providing margin above the `phi` floor.
3. **Analytics as a standalone revenue stream**: generates cash even when protocol volume is small.
4. **Multi-chain expansion** to Uniswap v3/v4, where TVL and LP volume are 5–10x Solana CLMM. The protocol math is unchanged.

### 10.2 Where it doesn't

1. If we cannot identify pools where `r_position > r*` in practice, RTs will not be sustainably profitable and the pool side dries up.
2. If retail LPs dominate the customer base, they tend to be price-sensitive and churn quickly; LTV collapses below COCA.
3. If a DEX (Uniswap, Orca) ships a native IL-hedging hook, the protocol is partially commoditised. This is a real risk: Uniswap v4's hook architecture is explicitly designed for this kind of extension.
4. If regulatory pressure pushes hedging products toward securities classification, the BVI structure may need restructuring and the addressable market shrinks to non-US, non-EU users.

### 10.3 Aulet's honest filter

DE explicitly warns against confusing "interesting research" with "viable business". Applying the test:

- **Is there a clearly identifiable customer with money?** Yes: semi-pro LPs and treasuries.
- **Is the value proposition quantified?** Yes, in the paper (vol/MaxDD/CVaR reductions).
- **Is the business model proven by other companies?** Partially: fee-on-premium is standard for derivative protocols; SaaS analytics is standard for DeFi tools.
- **Is the market reachable affordably?** Yes for the niche; expensive for retail.
- **Is the moat defensible?** Medium: the math is published (the paper is public), but the analytics + integration + measured pool universe are accumulating advantages.

**Honest verdict.** This is a *defensible niche business*, not a unicorn. Realistic 3-year revenue range: $500k–$5M ARR depending on multi-chain and analytics traction. It is profitable at the small end with a 5–8 person team, and substantially profitable at the high end. It is not a $100M ARR business unless follow-on markets (Uniswap, B2B) compound faster than this plan models.

---

## 11. Roadmap

### Phase 0: Now to Q3 2026 (Foundations)

- Publish DLT2026 paper (in flight).
- Complete Anchor program for protocol on Solana mainnet.
- Audit (Halborn / OtterSec / Neodyme: Solana-specialist auditors).
- Beta-test Analytics with 20 hand-picked LPs (curated via the DLT2026 audience and Solana ecosystem networks).
- Register as VASP in BVI (engage local counsel).

### Phase 1: Q4 2026 (Beachhead launch)

- Public mainnet launch on Orca with 3 curated pools.
- Open Risk Taker pool with seed capital ($500k–$2M from team + early supporters).
- Analytics free tier publicly available; Pro tier waitlisted.
- Target: 50 active LP customers, $200k cumulative premium volume in the quarter.

### Phase 2: Q1 to Q2 2027 (Expansion within Solana)

- Add Raydium CLMM and Meteora DLMM integrations.
- Open Pro and Institutional tiers of Analytics.
- Begin BD with two LP-management protocols (Kamino, Drift LP Vaults) for B2B integration.
- Target: 200 active LP customers, $1M cumulative premium volume.

### Phase 3: Q3 2027 onward (Multi-chain)

- Deploy on Ethereum L2 (Arbitrum or Base) targeting Uniswap v3.
- Explore Uniswap v4 hook deployment if v4 has shipped and stabilised.
- Build B2B revenue line.
- Target: 1000+ active LP customers, $10M+ cumulative premium volume.

---

## 12. Key Assumptions to Test (DE Step 20 to 21)

In priority order, the assumptions whose failure would kill the business:

1. **Pool universe assumption**: there exist enough Solana CLMM pools where `r_position > r*` to support a viable RT pool. *Test*: scan top 50 pools weekly; confirm 5+ pass the threshold.
2. **Customer willingness to pay assumption**: semi-pro LPs will pay 0.5%/week premium for 20–40% risk reduction. *Test*: 20 paid pre-orders or letters of intent before mainnet launch.
3. **RT supply assumption**: there exist DeFi-native counterparties willing to underwrite at `r*` for the projected risk-reward. *Test*: secure $500k–$2M in seed RT capital (own and partner) before launch.
4. **Customer acquisition cost assumption**: COCA stays below $500. *Test*: paid marketing pilot in Q4 2026 with explicit attribution.

---

## 13. Honest Closing Note

The Disciplined Entrepreneur framework's harshest test is Step 23: "show that dogs will eat the dog food". For LH, this means: produce 20 *paying* customers before raising serious capital. The DLT2026 paper is excellent technical evidence of *correctness*; it is not commercial evidence of *demand*. The single most important thing in the next two quarters is the Phase 1 customer acquisition test.

The paper's own honest verdict that the SOL/USDC 0.04% pool *does not currently clear breakeven* is the business's most important discipline: it forces pool-by-pool diligence rather than handwaving "DeFi is huge, therefore profit". A business that owns this discipline is more credible to sophisticated investors than one that ignores it.

---

## 14. Sources

- Aulet, B. (2013, 2024 ed.). *Disciplined Entrepreneurship: 24 Steps to a Successful Startup*: for the framework.
- Hasbrouck, Rivera & Saleh (2025). *An Economic Model of a Decentralized Exchange with Concentrated Liquidity*. Management Science: for the structural underpriced-call argument.
- Loesch, Hindman, Welch & Vesely (2021). *Impermanent Loss in Uniswap v3*: for the empirical "majority of LPs lose" finding.
- Schaller, A.J. (2022). *Hedging the Risks of Liquidity Providers*: for the Squeeth / power-perpetual analysis.
- BVI Virtual Asset Service Providers Act 2022: for the VASP regime overview.
- Solana DEX volume / TVL: cross-checked against DefiLlama and Birdeye dashboards at the time of writing; specific numbers should be re-verified at the time of any pitch.
- The DLT2026 paper itself (the LH Protocol paper): for all empirical numbers cited.

No numerical statistics in this document have been invented. Where figures are cited (CLMM TVL ranges, DEX volume, LTV/COCA), they are either (a) flagged as order-of-magnitude estimates, (b) sourced to the paper or to a public dataset, or (c) marked as assumptions to be tested. Any specific figure used in a real pitch must be re-verified against a current source on the day of the pitch: DeFi market sizes move materially week to week.
