# Privacy Notice

**Version 0.1-draft · [●] · DRAFT — NOT LEGALLY REVIEWED**

**Controller:** Blocksventures Ltd., BVI BC No. [●], registered office [●], email [●].
This Notice is drafted against the BVI **Data Protection Act 2021** ("DPA") and follows
GDPR-style principles as good practice. [COUNSEL: confirm DPA obligations and whether
GDPR applies extraterritorially given our user perimeter; EU/EEA users are currently
blocked from the paid service but may reach the free Site.]

## 1. What we collect — deliberately minimal

| Data | Source | Purpose |
|---|---|---|
| Wallet public address(es) | you connect/paste them | display your positions; form and settle contracts |
| Login signatures (SIWS) | your wallet | authentication (proves address control) |
| IP address → coarse geolocation result | your connection | security, rate limiting, jurisdiction gating (eligibility) |
| Consent/acknowledgment records (timestamps, document hashes, checkbox states) | you | contract formation evidence, legal defense |
| Quotes, term sheets, on-chain transaction signatures | platform + public blockchain | performing the hedging contract; accounting; audit |
| Support correspondence + optional email | you | responding to you; optional settlement notices |
| Technical logs (user agent, request metadata) | your browser | security monitoring, debugging |

We do **not** collect: names, identity documents (unless AML obligations are confirmed by
counsel — you will be told first), private keys or seed phrases (never — see the Terms),
advertising identifiers. We use **no third-party analytics or advertising trackers**;
only strictly necessary cookies/local storage (session, preferences).

**Public-blockchain caveat:** your wallet address, transactions with our Treasury, and
anchored document hashes are public on Solana by the nature of the technology,
permanently and outside our control. Do not use a wallet you consider private.

## 2. Legal bases and purposes

Performance of a contract (quotes, certificates, settlement); legitimate interests
(security, fraud prevention, defense of legal claims, service improvement from aggregate
usage); legal obligation (sanctions screening, record-keeping, lawful requests);
consent (optional email notices — withdrawable anytime).

## 3. Sharing

Infrastructure processors (hosting, error monitoring, backup storage — current list
published on the Site) under data-processing terms; RPC and market-data providers receive
technical queries (they see queried addresses, not your identity); professional advisers
and auditors; authorities where legally required; a successor entity on reorganization.
**We do not sell personal data.**

## 4. International transfers

We are a BVI company using EU/US cloud infrastructure. Transfers rely on contractual
safeguards with processors. [COUNSEL: DPA 2021 transfer conditions; SCC-equivalents.]

## 5. Retention

- Contract, consent, and settlement records: **6 years** after certificate settlement
  (BVI limitation period) [COUNSEL: confirm period].
- Security logs incl. IP: ≤ **12 months** unless part of an incident investigation.
- Support correspondence: 24 months after closure.
- Aggregated, de-identified statistics: indefinitely.

## 6. Your rights

Under the DPA (and as a matter of our policy for all users): access, correction, deletion
(where retention is not legally required), objection to legitimate-interest processing,
and withdrawal of consent. Write to [●]; we respond within 30 days. Note: we cannot
delete or alter blockchain data, and we must retain contract records for the period in §5
even if you ask for deletion. Complaints: BVI Information Commissioner [COUNSEL: confirm
supervisory authority and its operational status].

## 7. Security

Read-only architecture for monitoring; no custody of user keys; encryption in transit
(TLS 1.3) and at rest for backups; access on least-privilege; append-only audit logs with
on-chain integrity anchoring; incident response plan. If a breach creates risk to you, we
will notify you and the authority as required. [COUNSEL: DPA breach-notification rules.]

## 8. Children

The services are not directed at persons under 18; we do not knowingly process their
data.

## 9. Changes

New versions are posted with version number, date, and hash; material changes are
announced on the Site.
