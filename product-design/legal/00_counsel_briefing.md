# Counsel Briefing Memorandum — Liquidity Hedge Platform

**From:** Blocksventures Ltd. (the "Company")
**To:** BVI counsel
**Re:** Regulatory perimeter analysis + review/adaptation of the attached contract drafts
**Date:** [●] 2026
**Status:** Working drafts prepared internally. Nothing herein has been legally reviewed.

---

## 1. The Company

- Blocksventures Ltd., a BVI Business Company, company number [●], registered office [●],
  registered agent [●]. Directors/UBOs: [●].
- No licences or regulatory registrations currently held in any jurisdiction.
- Economic activity: software development and — subject to your advice — dealing as
  principal in the hedging contracts described below.

## 2. The product (two strictly separated modules)

**Module A — "Monitor" (free, read-only).** A web application. Users connect a Solana
wallet (signature-based login only; the Company never holds keys or assets) or paste a
public address; the app displays their Orca Whirlpool liquidity positions, valuations,
charts, and runs Monte-Carlo simulations clearly labeled as hypothetical. No payments, no
custody, no advice, no order routing. We believe this is unregulated software; please
confirm.

**Module B — "Hedge" (paid).** The Company, dealing as principal, sells the user a
"Liquidity Hedge Certificate": a 7-day, cash-settled bilateral contract referencing the
user's own concentrated-liquidity position. Economic terms (full math in draft 03):

- Payoff to buyer: `Π = V(S₀) − V(clamp(S_T, p_l, p_u))` — signed; bounded in
  `[−Cap_Up, +Cap_Down]`.
- Buyer pays at purchase, in USDC (Solana): Premium + Collateral equal to Cap_Up (their
  maximum possible obligation — the contract is therefore fully prefunded on both sides:
  the Company's maximum obligation is reserved against its treasury, the buyer's is
  posted upfront; no leverage, no margin calls).
- Settlement is automatic at expiry against a deterministic on-chain price source; net
  amount paid in USDC.
- Counterparty treasury: a Squads multisig wallet controlled by the Company; balances are
  publicly verifiable on-chain; a utilization cap (30%) limits aggregate exposure vs
  reserves.

## 3. What we ask you to determine (in priority order)

1. **SIBA.** Is the Certificate an "investment" under the Securities and Investment
   Business Act 2010 (we assume it resembles a cash-settled contract for differences /
   swap, Schedule 1), and is the Company carrying on "investment business" (dealing as
   principal) requiring a licence? If yes: which exclusions/exemptions are realistically
   available (e.g. dealing with professional/excluded persons only, no public offering,
   transaction structure changes), and what offering perimeter (invite-only, eligibility
   gating, marketing restrictions) would keep the Company outside, if any?
2. **VASP Act 2022.** Does receiving USDC premiums/collateral into, and paying
   settlements from, a Company-controlled wallet constitute "virtual assets service"
   (custody? transfer on behalf of another?) requiring VASP registration? Our position:
   the Company only ever holds its own property (premium once earned; collateral held as
   security — [COUNSEL: characterize collateral: title transfer vs security interest;
   title-transfer collateral may strengthen the "own property" analysis]).
3. **Public offer / marketing.** The site is public. What disclaimers, gating, and
   jurisdiction blocking are required so Module B is not a public offering? We currently
   plan: US persons blocked outright; EU/EEA blocked pending MiCA/MiFID II advice; BVI
   residents excluded; self-attestation + IP geoblocking; per-user caps; invite-only pilot.
4. **Consumer law override.** Buyers may be consumers in their home jurisdictions.
   Realistic assessment of: cooling-off/distance-selling rights, unfair-terms rules, and
   whether the arbitration clause and liability caps survive against consumers. What
   residual exposure remains regardless of drafting (we understand fraud/gross negligence
   cannot be excluded — the drafts do not attempt to).
5. **AML/CFT.** Do the Anti-Money Laundering Regulations / Code apply to this activity
   (is it "relevant business")? If yes: minimum KYC we must implement (we currently plan
   wallet screening + geoblocking only; no identity KYC at pilot).
6. **Economic Substance Act 2018.** Does the Certificate business fall in a relevant
   activity category (e.g. "finance and leasing"?) and what substance/reporting follows?
7. **Data protection.** Review of draft 05 against the BVI Data Protection Act 2021 and
   (to the extent applicable to non-EU establishment processing EU residents' data) GDPR.
8. **Electronic contracting.** Confirm click-wrap acceptance and hash-anchored versioning
   satisfy the BVI Electronic Transactions Act for these documents.
9. **Characterization risks.** Comfort that the Certificate is not: insurance (Insurance
   Act 2008) — no insurable-interest requirement is drafted, buyer must own the referenced
   position (which may actually help an insurance characterization — please analyze both
   directions); gaming/wagering; or a deposit.
10. **Tax.** BVI position (we assume none material) and any withholding on settlements.

## 4. Structural alternatives we are open to (if the base case fails)

- Professional/eligible-counterparty-only offering; higher minimum ticket.
- Restructuring as a fully-prepaid variable forward or note.
- A licensed route (SIBA Category [●]) with cost/time estimate.
- Moving the contracting entity or the offering perimeter offshore of the problem —
  please advise, do not assume we are wedded to the current structure.

## 5. The drafts attached (all prepared internally, all subject to your rewrite)

| # | Document | Module |
|---|---|---|
| 01 | Website Terms of Use | A (Monitor) |
| 02 | Master Hedging Terms and Conditions | B (Hedge) |
| 03 | Certificate Term Sheet template | B |
| 04 | Risk Disclosure Statement | B (acknowledged pre-purchase) |
| 05 | Privacy Notice | A + B |

Drafting conventions: `[●]` = factual placeholder for the Company to complete;
`[COUNSEL: …]` = a legal assumption or open question flagged for you specifically.

## 6. Engagement asks

Fixed-fee quote for: (i) perimeter memo covering §3; (ii) mark-up of drafts 01–05;
(iii) a short launch-conditions checklist we can wire into our release gate (our internal
gate "G3" blocks real-money launch on your sign-off). Target timeline: [●] weeks.
