# Liquidity Hedge: Pitch Deck Outline

A 12-slide deck for investor / partner conversations. One slide per section.
Sources for every claim are in `BUSINESS_PLAN.md` and the DLT2026 paper.
Numbers in `[VERIFY]` brackets must be re-checked on the day of the pitch.

---

## Slide 1: Title

**Liquidity Hedge**
*Protocol-level risk transfer for concentrated-liquidity positions*

DLT2026 paper: published.
PoC: live on Solana mainnet.

Founders: Sowelu Avanzo, Luca Pennella, Alex Norta, and team
Contact: [email]
BVI corporate entity in place

Visual: hero image of the signed-swap payoff curve `Pi(S_T)` with the asymmetric caps, lifted from paper Figure in Section 4.1.

---

## Slide 2: The Problem

**CLMM liquidity providers are losing to impermanent loss.**

- Empirical study (Loesch et al., 2021): a majority of Uniswap v3 LPs underperform HODL, fees do not compensate IL.
- Hasbrouck, Rivera & Saleh (2025, Management Science): a CLMM LP position is structurally equivalent to selling a covered call at intrinsic value. The position is therefore underpriced by construction.
- DefiLlama / Revert dashboards: many active CLMM pools have cumulative-fees-vs-IL ratio below 1.

**No existing instrument hedges CLMM IL with a single contract priced consistently with the LP payoff shape.**

Visual: bar chart of "LPs profitable vs unprofitable" from a known empirical study, dated.

---

## Slide 3: Why Existing Solutions Are Inadequate

| Solution | Limitation |
|---|---|
| On-chain options | Liquid only for ETH/BTC; missing for the long tail. |
| Power perpetuals | Squeeth was withdrawn; category did not stick. |
| Perpetual futures | Linear payouts do not match concave `V`; need continuous rebalancing. |
| Active LP managers (Gamma, Arrakis, Sommelier) | Manage the position, do not transfer the risk. |
| Bumper / Y2K | Hedge spot price or stablecoin depegs, not CL position equity. |

**The structural gap: no protocol issues a single CLMM-shaped risk-transfer contract.**

Visual: comparison matrix.

---

## Slide 4: Our Insight

**A signed-swap certificate that exactly matches the CL value function.**

The certificate's payoff `Pi(S_T) = V(S_0) - V(clamp(S_T, p_l, p_u))` transfers the LP's mark-to-market variability inside `[p_l, p_u]` to a Risk Taker, in exchange for a premium.

Single contract. Native to the CLMM payoff. Capped on both sides by the position's own range geometry.

Visual: three-panel comparison
1. Unhedged LP P&L curve (concave, asymmetric loss)
2. Signed-swap payoff curve `Pi(S_T)`
3. Hedged LP P&L (flat inside the range)

---

## Slide 5: The Proof (Theorem)

**Theorem 1 (Value Neutrality):**

```
LP_w(r) + RT_w(r) = U_w(r) - phi * P_w
```

The combined hedged-LP and Risk-Taker P&L equals the unhedged baseline minus only the protocol fee.

**Empirical verification:**
- 52-week SOL/USDC backtest: residual `< 10^-6 USDC` in every cell.
- Live mainnet settlements: identity holds to the granularity of integer accounting.
- 360-row sensitivity sweep: breakeven wedge `r* - r_u < 1 bps/day` everywhere.

**Implication:** the protocol neither creates nor destroys aggregate value. The only ecosystem cost is the governance-tunable fee.

Visual: theorem statement on left, residual histogram on right.

---

## Slide 6: Risk Reduction (Backtest Results)

**52-week SOL/USDC backtest, three widths, three fee tiers.**

| Width | Vol reduction | MaxDD reduction | CVaR(5%) reduction |
|---|---|---|---|
| ±5% | 22.4% | 14.9% | 10.7% |
| ±7.5% | 32.0% | 42.8% | 19.6% |
| ±10% | 41.3% | 60.0% | 28.9% |

(High-fee tier values; full table in paper Section 5.3.)

**The hedge is positive on every risk indicator, at every width tested.** Wider ranges produce larger reductions because terminal prices stay on the in-range branch more often.

Visual: the `chart_risk_reduction.svg` from `lh-protocol/docs/charts/`.

---

## Slide 7: Product

**LH Protocol** (on-chain, Solana / Anchor)
- Issues weekly Liquidity Hedge certificates.
- USDC underwriter pool, NAV share accounting.
- Off-chain Certificate Lifecycle Manager handles expiry / settlement / auto-close.
- Live integration with Orca Whirlpools mainnet.

**LH Analytics** (web app)
- Position monitoring across Orca / Raydium / Meteora.
- Pre-trade hedge simulator with projected `P_w` and risk-reduction metrics.
- Pool ranking by `r_position - r*`: identifies pools where the hedge clears breakeven.
- One-click hedge into the protocol.

Visual: product screenshots (or wireframes if not yet built).

---

## Slide 8: Market & Beachhead

**Beachhead: Solana CLMM LPs running positions ≥ $50k notional, with semi-professional or institutional sophistication.**

- Why Solana: Solana DEX volume has, on multiple recent months, exceeded Ethereum DEX volume. Orca and Raydium dominate Solana CLMM TVL. `[VERIFY: DefiLlama Solana DEX rankings]`
- Why this segment: well-funded, reachable, loss-averse, has an unmet need.
- Beachhead TAM (order of magnitude): ~$150k/year protocol revenue at conservative penetration. `[ASSUMPTION: tested in Phase 1]`

**Follow-on markets:**
1. Raydium / Meteora on Solana (~2 to 3x).
2. Uniswap v3/v4 on Ethereum + L2s (~10x).
3. B2B integrations with LP-management protocols.

---

## Slide 9: Business Model

**Three revenue lines:**

1. **Protocol treasury fee `phi`** = 1.5% of every premium paid.
   - Sustainable per Theorem 1: wedge bounded by `phi`.
2. **Analytics SaaS**:
   - Free: read-only dashboard.
   - Pro ($79/mo): simulator + alerts.
   - Institutional ($999+/mo): API + custom pools + reports.
3. **B2B / white-label** to Kamino, Drift, Arrakis, Gamma: 30 to 50% rev-share on hedges originated through their flows.

**Unit economics (assumptions, to be tested):**
- LTV per active LP: $1.8k (protocol-only) to $5.4k (with Analytics Pro).
- COCA per active LP: $200 to $500 in early phase.
- LTV/COCA: 4x to 27x. Aulet's heuristic is 3x minimum.

---

## Slide 10: Competitor Landscape

**Direct (CLMM IL hedging):** Active LP managers, Bumper, Y2K, legacy Bancor v2.
**Substitutes (alternative hedges):** Lyra/Premia/OPYN options, Hyperliquid/dYdX/Aevo perps, manual rebalancing.
**Indirect (analytics):** DefiLlama, Revert Finance, APY.vision, Gauntlet.

**LH is the only offering that combines:**
1. A rigorously priced single-contract IL hedge native to CLMM payoffs, AND
2. The analytics layer to identify pools where the hedge economically clears.

The combination is the moat.

Visual: 2x2 positioning chart (axis: "transfers risk vs. transforms it" x "CLMM-native vs. generic").

---

## Slide 11: Roadmap & Use of Funds

**Phase 0 (now to Q3 2026): Foundations**
- Mainnet Anchor program, audit, beta with 20 LPs, BVI VASP registration.

**Phase 1 (Q4 2026): Beachhead launch**
- Public launch on Orca with 3 curated pools.
- Seed RT pool ($500k to $2M).
- Target: 50 active LPs, $200k premium volume.

**Phase 2 (Q1 to Q2 2027): Solana expansion**
- Raydium + Meteora integrations, Analytics paid tiers, first B2B partnerships.
- Target: 200 active LPs, $1M premium volume.

**Phase 3 (Q3 2027 onward): Multi-chain**
- Uniswap v3 deployment on Arbitrum or Base.
- Target: 1000+ active LPs, $10M+ premium volume.

**Use of funds (seed):**
- 40% engineering (Anchor, Analytics frontend, multi-chain port).
- 25% RT pool seeding.
- 15% audits + legal (BVI VASP, US/EU geofence, KYC infra).
- 10% growth + BD.
- 10% reserve.

---

## Slide 12: Honest Risks & Ask

**Risks we own:**
1. Pool universe risk: SOL/USDC 0.04% does not currently clear breakeven. We commit to pool-by-pool diligence and only deploy on pools where the math works.
2. DEX-native hedging hooks (Uniswap v4) could partially commoditise.
3. Regulatory drift (securities classification of derivatives) could shrink TAM.

**Mitigations:**
- Discipline: scan pools weekly, only support those clearing `r*`.
- Defensible moat: integrated Analytics + measured pool universe + research authority.
- Geofence + BVI structure designed for non-US / non-EU compliance.

**Ask:** seed round of `$[X]M` for a 12-month runway through Phase 1.
- Use of funds as Slide 11.
- Cap table allocation: founders, advisors, seed investors.
- Target close: `[date]`.

---

## Appendix A (handout, not in main deck)

- Full DLT2026 paper PDF.
- Technical spec from `lh-protocol/docs/SUMMARY.md` and `06_implementation.md`.
- Goal model PDF (`LH Goal Model V2.2.drawio.pdf`).
- Business plan (`BUSINESS_PLAN.md`).
- Repository: github.com/SoweluAvanzo/LiquidityHedge

---

## Pitch delivery notes

- 10 to 12 minute pitch, 18 to 20 minute Q&A.
- Open with the residual-saturating-floating-point figure from Slide 5: it lands the formal claim hard and sets the tone of "we proved it".
- Close on Slide 12: explicitly say "we know SOL/USDC 0.04% does not clear breakeven today, here is what we are doing about it". Investors trust founders who present negative results faithfully more than founders who hide them.
- Reserve numbers: every `[VERIFY]` and `[ASSUMPTION]` tag must be replaced with a current source on the day of the pitch. DeFi numbers move week to week.
