# Risk Disclosure Statement — Liquidity Hedge Certificates

**Version 0.1-draft · [●] · hash-anchored on-chain · DRAFT — NOT LEGALLY REVIEWED**

Read this before purchasing a Liquidity Hedge Certificate. It is part of your contract
with Blocksventures Ltd. (the "Company"). It does not list every risk — only the main
ones we can foresee. If you do not understand this document, do not purchase.

## 1. You can lose everything you pay

The Premium is never returned, whatever happens. If the price at expiry is at or above
your entry price, you receive no payoff at all: the Premium is the cost of protection
that was not needed, exactly like an expired option. Additionally, if the price rises
above your position's upper bound you pay the capped maximum Cap_Up — that amount is
taken from the Collateral you posted at purchase. **Maximum total loss = Premium +
Cap_Up, both paid upfront. You can never owe more than you have already paid.**

## 2. Counterparty (credit) risk — the Company is not licensed, insured, or guaranteed

Any amount owed to you is an unsecured claim against Blocksventures Ltd., a small,
**unlicensed and unsupervised** BVI company. If the Company becomes insolvent you may
receive nothing, including your Collateral. There is no deposit insurance, no
investor-compensation scheme, and no regulator you can complain to about the product's
economics. The Company maintains published reserves and an exposure cap (Master Terms
§9), but these are internal controls, not guarantees.

## 3. This hedges a specific risk only — basis risks remain

The Certificate replicates the mark-to-market variability of your concentrated-liquidity
position **within its range, versus USDC, over 7 days**. It does not protect against:
loss of trading-fee income; the pool being exploited or drained; USDC losing its dollar
peg; risks of tokens other than the pair; anything after expiry; or a position you
modify during the tenor (modifying it breaches the contract — Master Terms §5.2).

## 4. Upside give-up

This is a swap, not free insurance. If the price **rises**, you pay the Company the
mirror-image of what the Company would pay you in a fall (capped at Cap_Up). Your hedged
position will underperform an unhedged one in rising markets. This is by design and is
why the Premium is lower than for one-sided protection.

## 5. Model and data risk

The Premium is computed from a mathematical model (risk-neutral GBM, Simpson quadrature)
fed by historical volatility and market data from third parties. Models simplify reality;
data can be wrong, stale, or manipulated. The "fair value", "viability" and simulation
outputs you see are hypothetical estimates, not promises, and may materially misstate
actual risk.

## 6. Settlement and oracle risk

The Settlement Price is read from the blockchain per a deterministic policy (Master Terms
§7.1). Blockchain congestion or halts, price-source failures, or manipulation of the
pool's price around expiry can delay settlement or produce a Settlement Price different
from prices you see elsewhere. Disruption procedures (Master Terms §8) give the Company
calculation discretion in extreme events.

## 7. Blockchain and technology risk

Transactions are irreversible; keys can be stolen; wallets, RPC providers, the Site, or
Solana itself can fail or be attacked; smart-contract-level exploits of Orca could impair
your Referenced Position independently of this contract. If you send payment incorrectly
(wrong amount, no reference, wrong token) no contract forms and recovery is per Master
Terms §4.4 (dust may be unrecoverable).

## 8. Legal, regulatory, and tax risk

The regulatory treatment of products like this is uncertain and evolving. Regulators in
your jurisdiction may consider the Certificate a regulated product offered unlawfully to
you; your contract could be affected, and your legal remedies may be limited or hard to
enforce against a BVI company. You are responsible for the legality of your purchase in
your jurisdiction and for all taxes. The Company may be required to stop offering,
suspend the Site, or disclose records to authorities.

## 9. Liquidity and exit risk

There is no secondary market. You cannot sell, transfer, or cancel a Certificate before
expiry.

## 10. Conflicts of interest

The Company is your direct counterparty: it profits when you do not claim, sets the
pricing model and parameters, operates the settlement infrastructure, and controls the
disruption procedures. These conflicts are structural; mitigations (published formulas,
deterministic settlement, on-chain verifiable records and reserves) reduce but do not
remove them.

---

**Acknowledgment.** By checking the acknowledgment boxes at purchase you confirm you have
read and understood this Statement and accept these risks. Keep a copy. This Statement is
versioned and hash-anchored; the version you accepted is recorded in your Term Sheet.
