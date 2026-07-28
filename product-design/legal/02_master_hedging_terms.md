# Master Hedging Terms and Conditions

**Version:** 0.1-draft · **Effective:** [●] · **Content hash:** [anchored on-chain]
**DRAFT — NOT LEGALLY REVIEWED — NOT IN FORCE — NO CERTIFICATES MAY BE SOLD UNDER THIS
DRAFT**

These Master Hedging Terms and Conditions (the "**Master Terms**") govern every Liquidity
Hedge Certificate entered into between **Blocksventures Ltd.**, a BVI Business Company,
company number [●] (the "**Company**"), and the person accepting these Master Terms (the
"**Buyer**"). Each Certificate is a private, bilateral, individually concluded contract
between the Company (dealing as principal) and the Buyer, formed as described in
Section 4. [COUNSEL: confirm this framing supports the no-public-offer position under
SIBA; see Briefing §3.1/3.3.]

## 1. Definitions

- "**Certificate**": a cash-settled bilateral contract on the terms of these Master Terms
  and a specific Term Sheet.
- "**Term Sheet**": the parameter document generated for a specific quote (template in
  Annex 1), identified by its content hash.
- "**Referenced Position**": the Buyer's Orca Whirlpool concentrated-liquidity position
  identified in the Term Sheet by its position mint address.
- "**Corridor**": the price range `[p_l, p_u]` of the Referenced Position stated in the
  Term Sheet.
- "**Entry Price (S₀)**", "**Settlement Price (S_T)**": as defined in Sections 5 and 7.
- "**V(S)**": the position value function defined in the Term Sheet (the standard
  concentrated-liquidity valuation formula).
- "**Payoff (Π)**": `Π = V(S₀) − V(clamp(S_T, p_l, p_u))`, where
  `clamp(x, a, b) = min(max(x, a), b)`. Π is signed: positive amounts are owed by the
  Company to the Buyer; negative amounts are owed by the Buyer to the Company.
- "**Cap_Down**": `V(S₀) − V(p_l)` — the maximum amount the Company can owe.
- "**Cap_Up**": `V(p_u) − V(S₀)` — the maximum amount the Buyer can owe.
- "**Premium**": the price of the Certificate, computed per the published formula
  `Premium = max(P_floor, FV · m_vol − y · E[F])` and itemized in the Term Sheet.
- "**Collateral**": USDC in the amount of Cap_Up, transferred by the Buyer at purchase by
  way of **outright transfer of title** to secure the Buyer's maximum possible obligation.
  [COUNSEL: title-transfer vs security-interest characterization — Briefing §3.2.]
- "**USDC**": the fungible token issued by Circle on the Solana blockchain at mint
  address `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- "**Treasury**": the Company's multisignature wallet address(es) published on the Site.
- "**Tenor**", "**Expiry Time**": the 7-day (604,800 seconds) protection period and its
  end time stated in the Term Sheet.
- "**Finalized**": confirmed at the Solana "finalized" commitment level.

## 2. Nature of the contract — key acknowledgments

2.1 The Certificate is a bilateral contract with the Company as your sole counterparty.
It is **not** insurance, **not** a deposit, **not** a security offered to the public,
**not** a fund interest, and confers no rights in the Referenced Position or against any
third party. [COUNSEL: confirm each characterization; insurance analysis per Briefing
§3.9.]

2.2 The Company is **not licensed or supervised by any financial regulator**, including
the BVI Financial Services Commission. No regulator has reviewed the Certificate or these
Master Terms. No compensation or investor-protection scheme applies.

2.3 The Certificate is **not custody**: the Referenced Position remains in the Buyer's
wallet and control at all times. The Company holds only the Premium and Collateral.

2.4 The Buyer has read and accepted the Risk Disclosure Statement and understands that
**the entire Premium may be lost with nothing paid in return** (if `S_T ≥ S₀`), that the
Buyer may additionally owe up to Cap_Up (prefunded by the Collateral), and that payment
of any amount owed by the Company depends on the Company's solvency (Section 9).

## 3. Eligibility

3.1 The Buyer represents, on formation and continuously: (a) 18+ years old and of full
legal capacity; (b) not a US person (as defined in Regulation S under the US Securities
Act), not resident or located in the United States, the European Union or EEA, the United
Kingdom, the British Virgin Islands, or any jurisdiction listed as prohibited on the Site
[COUNSEL: confirm exclusion list — EU/UK pending MiCA/FCA analysis; BVI exclusion
intended to support the perimeter position]; (c) not a sanctioned person and not acting
for one; (d) the sole beneficial owner and controller of the wallet used and of the
Referenced Position; (e) acting for their own account, understanding derivatives and
concentrated-liquidity mechanics, and not relying on any advice from the Company;
(f) not circumventing geographic restrictions (including by VPN).

3.2 The Company may refuse any purchase, and may cap per-Buyer and aggregate exposure, in
its sole discretion.

## 4. Formation, payment, and activation

4.1 **Quote.** On the Buyer's request the Site displays a quote: the Premium, Cap_Down,
Cap_Up, Corridor, Entry Price, Expiry Time, all formula inputs, and the generated Term
Sheet with its content hash. A quote is an offer by the Company open for the validity
period shown (typically ≤ 120 seconds) and lapses automatically.

4.2 **Acceptance.** The Buyer accepts by (i) confirming acceptance of these Master Terms,
the Term Sheet, and the Risk Disclosure through the Site's acknowledgment flow, and
(ii) transferring exactly **Premium + Collateral** in USDC to the Treasury in a single
transaction carrying the unique payment reference stated in the quote.

4.3 **Activation.** The Certificate becomes effective ("**Active**") only when the
payment transaction is Finalized and matched to the quote's reference before the quote
lapses. The Company will record activation and anchor the Term Sheet hash on-chain.

4.4 **Failed formation.** If payment is not Finalized in time, is for a wrong amount, a
wrong token, or lacks the reference: no Certificate arises, and the Company will return
identifiable funds to the sending address, less network fees, within [5] business days.
Amounts under [USD 1] are not returned (uneconomic dust). [COUNSEL: confirm
enforceability of the dust threshold and the refund SLA.]

4.5 **No cancellation.** Once Active, the Certificate cannot be cancelled or terminated
early by either party, except as provided in Sections 8 and 10. [COUNSEL:
cooling-off/withdrawal rights of consumers in their home jurisdictions — can these be
excluded for a fully-performed financial product with express consent at purchase?]

## 5. Entry data

5.1 The Entry Price S₀ is the Referenced Position's pool price read on-chain at quote
time; the Corridor is read from the Referenced Position's on-chain range; both are stated
in the Term Sheet and are conclusive absent manifest error.

5.2 The Buyer must keep the Referenced Position **unchanged** during the Tenor: no
liquidity increase/decrease, no closure, no transfer of the position NFT. Breach entitles
the Company to settle early at its option per Section 8.2 (with S_T determined at the
breach time) or to treat the Certificate as void with the Premium forfeited as liquidated
damages. [COUNSEL: liquidated-damages vs penalty analysis under BVI common law.]

## 6. Fee split

6.1 As part of the price, the Buyer agrees that y% (stated in the Term Sheet, default
10%) of the trading fees accrued by the Referenced Position during the Tenor (the "**Fee
Split Amount**", measured from on-chain fee-growth data between activation and expiry) is
payable to the Company and will be netted into the Settlement Amount. The expected value
of this amount is already credited to the Buyer as a Premium discount (the `y · E[F]`
term).

## 7. Settlement

7.1 **Settlement Price policy (deterministic).** S_T is the Referenced Position's pool
price read on-chain at Finalized commitment by the settlement engine on its first
settlement cycle at or after the Expiry Time (cycles run at most [60] seconds apart;
the price and the slot it was read at come from a single finalized response and both
are recorded). The reading is cross-checked against an independent price source. If
the two diverge by more than [1]%, **or the independent source is unavailable**,
settlement is deferred to a subsequent cycle and re-attempted until a reading passes
the cross-check; a deferral can therefore extend settlement until the independent
source recovers or the divergence clears. The price actually used, its slot, the
cross-check value and the cross-check source are recorded and reproducible; a record
asserting agreement with a source that was not consulted cannot be produced.

7.2 **Settlement Amount** (positive = payable to Buyer):
`Settlement = Π(S_T) − FeeSplitAmount + Collateral`.
The Company shall pay any positive Settlement Amount in USDC to the Buyer's purchase
wallet within [24] hours of the Settlement Price determination. Since Π ≥ −Cap_Up and the
Collateral equals Cap_Up, the Settlement Amount is never negative and the Buyer never
owes anything beyond amounts already paid. [Check: FeeSplitAmount ≤ y × accrued fees;
if accrued fees cannot be read (data failure), FeeSplitAmount = 0 in the Buyer's favor.]

7.3 States: an Active Certificate ends as "Settled" (Π ≠ 0) or "Expired" (Π = 0);
Collateral is returned in both cases per 7.2.

7.4 Settlement obligations survive any suspension of the Site or of new sales.

## 8. Adjustments and disruption

8.1 **Disruption events**: Solana network halt or fork affecting finality; unavailability
or manifest corruption of price sources; the Referenced Position's pool being frozen,
exploited, or migrated. During a disruption the Expiry Time and payment deadlines are
extended by the disruption's duration, up to [72] hours; thereafter the Company shall
determine S_T in good faith from the best available evidence, documented and disclosed.
[COUNSEL: calculation-agent discretion standard — "good faith and commercially reasonable
manner"; dispute right.]

8.2 **Early settlement for breach** (Section 5.2): S_T is determined at the breach time
using the same policy as 7.1, and settlement otherwise proceeds per Section 7.

## 9. Company's obligations; reserves; no recourse beyond the Company

9.1 The Company's maximum liability under a Certificate is Cap_Down plus return of
Collateral. On each sale the Company reserves Cap_Down against its published Treasury and
enforces a utilization cap ([30]% of reserves) across all outstanding Certificates.
Treasury balances are publicly verifiable on-chain; reserve and exposure figures are
published on the Site.

9.2 The Buyer's claims are unsecured contractual claims against the Company only.
[COUNSEL: whether a segregated/secured structure (e.g. trust over treasury, SPC) is
advisable — we are open to it.]

## 10. Suspension and termination of the offering

The Company may at any time stop offering new Certificates. Active Certificates are
unaffected and will be settled per Section 7 in all cases, including wind-down.

## 11. Taxes

All amounts are exclusive of taxes. Each party bears its own taxes; the Buyer is solely
responsible for any tax arising from Certificate outcomes in their jurisdiction. The
Company may withhold where required by law.

## 12. Liability

12.1 Sections 6 and 7 of the Website Terms of Use (warranty disclaimer, liability
limitation) apply to the hedging service, except that the aggregate cap for claims
relating to a Certificate is the **greater of USD 100 and the sum of Premium paid plus
amounts due under Section 7** for that Certificate.

12.2 Nothing excludes liability for fraud or fraudulent misrepresentation or any
liability incapable of exclusion at law. Settlement obligations under Section 7 are debts,
not damages, and are not limited by 12.1.

## 13. Representations of the Company

The Company deals as principal, on its own account; it does not act as the Buyer's agent,
adviser, or fiduciary; and it has not made and makes no representation about the future
performance of any asset or position.

## 14. Records; electronic contracting; language

The Site's audit records (quotes, acknowledgments, transaction signatures, Term Sheet
hashes anchored on Solana) are prima facie evidence of formation and terms. Electronic
acceptance binds the parties. [COUNSEL: BVI Electronic Transactions Act confirmation.]
The contract language is English.

## 15. Amendments

Amendments to these Master Terms apply only to Certificates formed after the amendment's
effective date; each Certificate is governed by the Master Terms version whose hash its
Term Sheet cites.

## 16. Governing law and arbitration

16.1 The Master Terms and each Certificate are governed by the laws of the British
Virgin Islands.

16.2 Disputes: final and binding arbitration administered by the BVI International
Arbitration Centre under its Rules; seat Road Town, Tortola; one arbitrator; English
language. The parties waive participation in class or collective proceedings to the
extent permitted by law. [COUNSEL: enforceability against consumers; carve-out for
small claims?]

## 17. General

No assignment by the Buyer without consent (the Company may assign to an affiliate or
successor with notice, provided the assignee assumes all obligations); severability;
entire agreement (Master Terms + Term Sheet + Risk Disclosure + Privacy Notice); no
waiver by conduct; no third-party rights; notices via the Site and to the contact details
in the Term Sheet.

---

## Annex 1 — Term Sheet template: see document 03.
