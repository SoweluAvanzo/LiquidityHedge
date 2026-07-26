# LH Platform — STRIDE Threat Model (Phase 0 baseline, v0.1)

Scope: the target architecture from `01_requirements.md` / `02_stack_plan_validation.md`.
Living document — revisit at every gate (G1/G2/G3) and after any architecture change.

## 1. Assets (what an attacker wants)

| ID | Asset | Impact if compromised |
|---|---|---|
| A1 | RT treasury (USDC in Squads vault + hot-wallet float) | direct fund loss |
| A2 | Certificate/payment ledger (Postgres) | wrong liabilities, double payouts |
| A3 | Quote/regime inputs (σ, IV, price feeds) | mispriced premiums → slow drain |
| A4 | Settlement price source | adversarial settlement → targeted drain |
| A5 | User trust in the web UI | wallet-drainer injection, phishing |
| A6 | Audit/consent records | legal exposure, repudiation |
| A7 | Server signing keys (receipts, SIWS session secrets) | forged receipts/sessions |

## 2. Trust boundaries

- **B1** Browser ↔ API (public internet)
- **B2** API ↔ workers ↔ Postgres/Redis (internal)
- **B3** Workers ↔ external vendors (RPC, Birdeye, Binance) — *untrusted inputs*
- **B4** Workers ↔ Solana mainnet (payment detection, settlement payouts, anchoring)
- **B5** Operator/admin access (ops dashboard, multisig signers)
- **B6** User wallet ↔ dapp (wallet-adapter surface)

## 3. STRIDE by boundary (top findings)

### B1 Browser ↔ API
- **S**poofing: session hijack → SIWS with nonce + expiry, httpOnly SameSite cookies.
- **T**ampering: request forgery → zod validation, CSRF tokens, idempotency keys.
- **R**epudiation: "I never bought this" → signed consent flow, term-sheet hash in the
  purchase record, full event trail (FR-L4, NFR-A1).
- **I**nfo disclosure: portfolio data is public-chain anyway; still rate-limit scraping,
  no cross-user data in API responses (authz per wallet).
- **D**oS: Cloudflare WAF + per-IP and per-wallet rate limits; simulation jobs quota'd
  per user (FR-S6) so MC requests can't exhaust workers.
- **E**levation: admin routes on a separate origin + IP allowlist + hardware-key MFA.

### B3 Vendor inputs (highest *pricing* risk)
- Tampering/spoofing of Birdeye/Binance responses → TLS + schema validation + sanity
  bounds (σ clamps exist in core; add cross-source divergence checks).
- **Stale/truncated data (CONFIRMED REAL, Phase-0 spike):** Birdeye caps responses at
  1000 candles; the prototype adapter does not paginate, so "30d of 15m candles" silently
  became ~10 days ending ~3 weeks in the past. Platform ingestion MUST paginate, verify
  candle-count × coverage-window, and refuse to update the regime on degraded data
  (loud, never silent — §E7). Alert on regime staleness > 900 s (FR-A2/A5).
- An attacker who can influence the *inputs* to quoting (e.g., wash-trading a thin pool to
  distort measured fee yield) gets systematically cheap premiums → quote only on
  allowlisted deep pools at launch (SOL/USDC), monitor IV/RV outliers.

### B4 Solana mainnet (highest *treasury* risk)
- Payment spoofing: fake/underpaid transfers → verify mint, amount, finalized commitment,
  reference key uniqueness; never activate on `confirmed` (AR-8).
- Replay/duplicate crediting: one transfer credited to two quotes → reference key is
  single-use, DB-unique; reconciliation sweep (FR-A5).
- Settlement-price manipulation: single-slot pool price push at expiry → AR-7 median/
  cross-check + divergence fallback; caps bound the damage per certificate (Cap_down).
- Hot-wallet key theft → float cap (≤ configured limit), separate container, outbound
  allowlist, anomaly alert + kill switch (FR-A4, SR-8); bulk funds stay in Squads 2-of-3.
- Anchoring memo forgery is harmless (anyone can send memos) — verification always
  recomputes the Merkle root from our ledger; the on-chain memo is a commitment, not a
  source of truth.

### B6 Wallet surface (highest *user* risk)
- Supply-chain injection into the frontend = wallet drainer → no third-party scripts,
  self-hosted deps, lockfile pinning, CI secret/dep scanning, strict CSP (NFR-SEC4/5).
- Phishing clones of the site → publish official domain in T&C and on the anchored
  transparency page; SIWS statement includes the origin.
- Malicious transaction requests: v1 requests only plain USDC transfers to the published
  treasury address with a memo/reference — trivially inspectable in every wallet. No
  arbitrary program interactions are ever requested (NFR-SEC2).

### B2/B5 Internal & operator
- SQL injection/tampering → parameterized queries only (Drizzle), append-only grants on
  `events` (SR-4).
- Log forgery/repudiation → daily Merkle root anchored on-chain (AR-6).
- Insider/coerced operator → multisig for treasury moves above float; audit trail of admin
  actions; least-privilege DB roles.
- Backup theft → encrypted at rest (restic), keys held separately (NFR-SEC6).

## 4. Abuse cases (economic, not just technical)

| Case | Vector | Mitigation |
|---|---|---|
| Adverse selection | buyer with private short-term information buys just before expected move | m_vol markup + stress flag exist in core; 7-day tenor limits timing edge; monitor realized-vs-expected payout ratio (severity feedback done properly, §E9) |
| Utilization squeeze | many simultaneous quotes exhaust headroom then dump risk | quote validity window ≤ 120 s; headroom re-checked at activation, not just quoting |
| Griefing via dust payments | thousands of tiny wrong payments to exhaust refund ops | refund-minus-network-fee policy (FR-H4), min premium = P_floor $1.50, batch refunds |
| Oracle-window sniping | trade the pool at the expiry slot | AR-7 cross-check + divergence fallback window |

## 5. Residual risks accepted at pilot (owner sign-off required)

1. No professional penetration test before G3 (compensating: DAST, external flow review,
   caps, invite-only).
2. Single-operator availability (compensating: runbooks, kill switch, monitors).
3. Counterparty concentration — the RT pool is the company treasury (disclosed, FR-H7).
4. Vendor dependence for volatility inputs (compensating: dual-source IV when available,
   clamps, refusal-on-degraded-data).
