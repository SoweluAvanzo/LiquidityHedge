# LH Product — Requirements Specification (v0.2, evaluated & corrected)

Product: **Liquidity Hedge Platform** — a web application for (1) monitoring and simulating
concentrated-liquidity position portfolios on Orca (Solana), and (2) selling Liquidity Hedge
certificates (signed-swap payoff, per the DLT2026 paper) against a centralized RT treasury.

Operator: Blocksventures Ltd. (BVI). Prototype basis: `lh-protocol/` (audited 2026-07-07,
192 tests passing).

This version incorporates the consistency/feasibility evaluation pass (§E) — corrected
requirements are marked **[corrected]** with the original intent noted.

---

## 0. Product principles

- **P1 — Two legally and technically separated modules:** *Monitor & Simulate* (free,
  read-only, non-custodial — no money accepted) and *Hedge* (paid, gated). The first must
  never depend on the second.
- **P2 — Non-custodial by default:** the platform never holds user private keys, never asks
  for seed phrases, and never takes custody of the user's Orca position in v1.
- **P3 — Every number explainable:** any premium, payoff, or simulation result can be
  reproduced from stored inputs (audit-first, from the prototype's event-audit design).
- **P4 — Trust through verifiability, not custody:** on-chain anchoring of commitments via
  existing audited programs only (no custom program in v1 — see cost gate AR-6).
- **P5 — Model-agnostic simulation core:** all stochastic components consume the `RiskModel`
  port (AR-5) so third-party price models can be plugged in later without engine changes.

---

## 1. Functional Requirements

### 1.1 Wallet & identity (FR-W)

- **FR-W1** Users connect Solana wallets through the app UI via the Wallet Standard
  (Phantom, Solflare, Backpack, Ledger at minimum). Connection is read-only; transactions
  are only ever signed inside the user's wallet.
- **FR-W2** Authentication = Sign-In-With-Solana (CAIP-122 style message signature); no
  passwords, no email required for the Monitor module.
- **FR-W3** Multiple wallets per user session; plus **watch-only addresses** (paste a public
  key) for monitoring, clearly labeled as unverified.
- **FR-W4** The app never requests seed phrases or private keys anywhere; anti-phishing UI
  cues (origin display, no inline key inputs) are mandatory.

### 1.2 Portfolio monitoring (FR-M)

- **FR-M1** Discover all Orca Whirlpool positions (incl. position bundles) owned by
  connected/watched wallets by scanning position NFTs and decoding on-chain accounts
  (reuse `market-data/decoder.ts`).
- **FR-M2** Per position, show at least Orca-frontend parity for *current state*: pool,
  price range `[p_l, p_u]`, in-range status, current price, token quantities
  (`amount_A/amount_B`), position value (USD), uncollected fees (reuse the off-chain
  `feeGrowthInside` replication in `lifecycle/fee-refresher.ts`), fee APR estimate.
- **FR-M3 [corrected]** P&L: *from-first-seen* P&L computed against a snapshot taken when
  the position is first registered in the platform, plus optional user-entered cost basis.
  Full historical cost basis from transaction-history parsing is **Phase-2+ best-effort**,
  not v1. *(Original: "all P&L"; corrected because reliable entry-price reconstruction
  requires indexing historical transactions — expensive at our budget.)*
- **FR-M4** Portfolio aggregation across wallets and positions: total value, aggregate P&L,
  token exposure breakdown, share of value in-range/out-of-range.
- **FR-M5** P&L-vs-price curves: interactive chart of `V(S)` (and portfolio `ΣV_i(S)`)
  as token price varies, using the exact 3-piece value function from
  `pricing-engine/position-value.ts`; overlay of hedged payoff
  `V(S) + Π(S)` when a certificate is attached; IL decomposition (price P&L vs fee income).
- **FR-M6** Time-series dashboard: position/portfolio value and P&L over time from ingested
  price history + periodic position snapshots.
- **FR-M7** Data freshness: prices ≤ 10 s staleness, position state ≤ 60 s (poll-based,
  budget-tiered), with visible "as of" timestamps and manual refresh.
- **FR-M8** **Viability Index** per position: `VI = r_measured / r_breakeven`
  *(updated 2026-07-28 to match the shipped Phase-1 estimator chain)*:
  `r_measured` is the realised in-range fee intensity from the position's own
  `feeGrowthInside` accumulator × the forward in-range fraction when ≥6h of
  history exists, else the measured pool yield (own `feeGrowthGlobal`
  snapshots; Birdeye as labelled fallback) × in-range fraction ×
  concentration factor. `r_breakeven` for the FIRST index is the markup-drag
  breakeven (fees vs the hedge's cost above fair value); the SECOND,
  two-sided index (paper §2.4.3–2.4.4) uses `r* = r_u + φP/(V·T)`. Both ship
  with 90% uncertainty bands, provenance labels, and are suppressed for
  out-of-range positions (decision D2b).
- **FR-M9** Historical market data ingestion: OHLCV (15 m and 1 d) for supported tokens,
  target retention ≥ 3 years, with gap detection/backfill and a documented fallback source
  (vendor-risk mitigation, see §E7).

### 1.3 Simulation engine (FR-S)

- **FR-S1** Monte Carlo simulation of position/portfolio value over a user-selected horizon
  under at least two models: **GBM** (as in the prototype pricing engine) and **empirical**
  (bootstrap of historical log-returns; IID and block bootstrap), with historical window
  selectable (1 y / 2 y / 3 y / custom, subject to data availability).
- **FR-S2** Granular configuration (all persisted per run): number of paths (100–100,000),
  horizon and step size, RNG seed, drift mode (zero / risk-neutral / historical / custom),
  volatility source (RV-30d / RV-7d / IV / custom σ), fee-yield model (none / constant
  bps-per-day / volume-derived), out-of-range behavior (hold / assume rebalance at cost),
  hedged-vs-unhedged toggle (applies the certificate payoff `Π` with premium), and — for
  multi-asset portfolios — **joint modeling**: block bootstrap over aligned return vectors
  (preserves empirical correlation) or correlated GBM with a user-visible correlation
  matrix. **[added in evaluation — independent per-asset paths would misstate portfolio
  risk]**
- **FR-S3** Outputs: percentile fan chart of portfolio value, terminal-value distribution,
  P(loss), VaR/CVaR(5%), max-drawdown distribution, probability of exiting the range,
  expected fees, hedged-vs-unhedged side-by-side (reusing the backtest comparison logic
  from `scripts/generate-summary-charts.ts`).
- **FR-S4** Reproducibility: every simulation stores `{model id+version, full config, seed,
  data snapshot ref}`; results exportable (CSV/JSON) and re-runnable bit-identically.
- **FR-S5** All simulation and pricing paths consume the `RiskModel` port (AR-5); adding a
  model must require zero changes to the engine or the UI shell (model registry provides a
  config schema the UI renders generically).
- **FR-S6** Performance envelope: 10,000 paths × 52 weekly steps × 10 positions completes
  in ≤ 10 s p95 server-side; small runs (≤ 1,000 paths) may run client-side using the same
  core compiled for the browser.

### 1.4 Hedging (FR-H)

- **FR-H1** Quote generation for an eligible Orca position using the prototype's canonical
  engine unchanged: `Premium = max(P_floor, FV·m_vol − y·E[F])` with Simpson-quadrature FV
  (`computeQuote`), regime snapshot freshness ≤ 900 s, utilization/headroom guard.
  The quote UI must show the full breakdown: FV, m_vol (and IV/RV inputs), y·E[F],
  P_floor, Cap_down, Cap_up, protocol fee.
- **FR-H2** Product terms per the paper's Product A: corridor = the position's own range
  `[p_l, p_u]`, tenor 7 days, payoff `Π = V(S_0) − V(clamp(S_T, p_l, p_u))`, USDC
  settlement. A per-quote **term sheet** (parameters + formulas + worked payoff table) is
  generated, content-hashed, and the hash included in the purchase record.
- **FR-H3 [corrected]** Purchase & collateral: the buyer pays, in USDC to the RT treasury,
  `Premium + Cap_up` — the premium plus their **maximum possible obligation** on the upside
  leg (by the convexity wedge, `Cap_up < Cap_down`, typically ~3–4× smaller). Settlement
  nets against this collateral; unused collateral is returned with the payout. *(Original
  design settles the LP-owes-RT leg "physically from the escrowed position"; v1 has no
  escrow, so without upfront collateral the signed swap is unenforceable — see §E3.)*
- **FR-H4** Payment flow: unique payment reference per quote (reference key on the USDC
  transfer), quote validity window consistent with regime freshness, certificate becomes
  Active **only** after the transfer is observed at `finalized` commitment and reconciled
  exactly-once; under/over/late payment policies defined and automated (refund minus
  network fee).
- **FR-H5** Certificate lifecycle mirrors the prototype state machine
  (Active → Settled | Expired) with the platform adding: live estimated payoff, countdown,
  and post-settlement statement (price used, payoff, fees split, collateral returned).
- **FR-H6** Settlement: automated at expiry; **settlement price policy** (AR-7) applied
  deterministically; payouts: RT→LP paid from treasury in USDC; LP→RT taken from the
  posted collateral. Every settlement runs the Theorem 2.2 residual assertion (reuse
  `lifecycle/settle.ts`) and alerts on violation.
- **FR-H7** RT pool transparency: public page with treasury address(es), verifiable
  on-chain balance, total active exposure (Σ Cap_down), utilization vs `U_max = 30%`,
  and the quote-refusal rule when headroom is insufficient (reuse `availableHeadroom`).
- **FR-H8** Contract transparency: plain-language explainer, interactive payoff diagram
  (Π vs S_T with both caps marked), at least two worked examples (price down / price up),
  total cost disclosure, and a versioned T&C whose hash is anchored on-chain (AR-6).
  Purchase requires explicit acknowledgment (scroll-through + discrete checkboxes);
  consent records retained (FR-L4).
- **FR-H9** Eligibility gating: jurisdiction gating (IP geoblock + self-attestation),
  wallet screening against public sanctions lists, per-wallet and global exposure caps,
  invite-only flag for the pilot.
- **FR-H10** Receipts: downloadable server-signed (Ed25519) purchase/settlement receipts;
  optional compressed-NFT receipt minted to the buyer (deferred if on-chain budget tight).

### 1.5 Legal & transparency (FR-L)

> ⚠️ See §E2. The platform can be *structured to minimize* licensing triggers, but no
> structure or disclaimer guarantees "no license needed" or complete liability shelter.
> BVI counsel sign-off is a **blocking gate** for the Hedge module.

- **FR-L1** Contract suite under BVI law reviewed by BVI counsel: Website Terms of Use
  (Monitor module), Master Hedging Terms + per-certificate term sheet (Hedge module), Risk
  Disclosure Statement, Privacy Notice. Include: bilateral OTC framing, no-advice clause,
  arbitration (BVI IAC) + BVI governing law, liability limited to the maximum extent
  permitted (noting fraud/gross negligence cannot be excluded), express no-insurance /
  no-deposit-taking characterization, and clear identification of the RT counterparty.
- **FR-L2** Regulatory-perimeter analysis (counsel deliverable, informs FR-H9 geofencing):
  BVI SIBA 2010 (the certificate is economically a cash-settled derivative — Schedule 1/2
  analysis), BVI VASP Act 2022 (accepting/paying USDC from a company wallet), EU MiCA +
  MiFID II if EU residents are served, and equivalent US analysis (default: US persons
  blocked; EU pending counsel).
- **FR-L3** The Monitor & Simulate module carries "hypothetical performance / not advice"
  labeling on every simulation output; no recommendations, rankings, or "expected profit"
  language anywhere in the UI.
- **FR-L4** Records: append-only audit of quotes, term sheets, consents, payments,
  settlements, and T&C versions, retained ≥ 6 years (BVI limitation period), exportable.
- **FR-L5** GDPR-aligned data minimization even if EU users are excluded: personal data
  limited to wallet address, IP-derived geolocation result, consent records, optional
  email; documented lawful basis, retention schedule, and a data-subject-request process.
- **FR-L6** A complaints/contact channel with tracked tickets and target response times
  stated in the T&C.

### 1.6 Operations & administration (FR-A)

- **FR-A1** Ops dashboard: treasury reserves & float, active certificates and upcoming
  settlements, utilization, regime snapshot age (alert > 900 s), data-feed health, invariant
  monitor status.
- **FR-A2** Regime updater job: σ (30 d/7 d) from OHLCV, IV from the Binance options
  adapter (wire the existing but currently-unused `computeIvRvFromDualSource` when a second
  source is added), severity/markup per `risk-analyser/regime.ts`; publishes signed regime
  snapshots consumed by quoting.
- **FR-A3** Treasury: main reserves in a **Squads multisig** (2-of-3); an operational hot
  wallet holds a capped float (config, e.g. ≤ $2,000) for automated settlement payouts;
  payouts above the float threshold queue for multisig approval within a stated SLA.
- **FR-A4** Kill switch: instantly pause quoting/purchases without affecting settlements —
  users must always be able to receive what they are owed.
- **FR-A5** Runtime invariant monitors with alerting: Theorem 2.2 residual per settlement,
  pool solvency (`reserves ≥ ceil(activeCap·BPS/uMaxBps)`), payment reconciliation
  (no orphan payments / no unpaid-active certificates), oracle divergence.

## 2. Non-Functional Requirements

### 2.1 Security (NFR-SEC)

- **NFR-SEC1 [corrected]** Security target: **OWASP ASVS 5.0 Level 2** for the whole app,
  **Level 3 controls** for payment, settlement, and treasury components; ISMS built
  **aligned to ISO/IEC 27001:2022** (risk register, Statement of Applicability, policies,
  asset inventory, incident response, supplier review) in a *certification-ready* state.
  *(Original: "ISO certification of absolute security per EU standards" — no standard
  certifies absolute security; ISO 27001 certifies the management system and external
  certification costs ~€15–40k, deferred until revenue justifies it. Relevant EU frameworks
  mapped instead: GDPR (FR-L5); MiCA/MiFID II via FR-L2; NIS2/DORA assessed as not
  applicable to a BVI micro-entity at this stage — revisit if EU establishment occurs.)*
- **NFR-SEC2** Non-custodial invariants: no private-key material, no seed-phrase input, no
  transaction construction that the wallet cannot fully simulate/display; all
  server-composed transactions are transparent (single well-known program interactions).
- **NFR-SEC3** Key management: treasury = multisig (FR-A3); hot-wallet key in an encrypted
  secret store with runtime-only decryption, balance capped; server signing keys rotated;
  **no key or .env files inside the repository tree** (relocate the existing local
  `wallet-*.json`/`.env` out of the project directory).
- **NFR-SEC4** Supply-chain: lockfile-pinned dependencies, automated vulnerability + secret
  scanning in CI, SBOM generation, no third-party scripts/CDNs on pages with wallet access
  (drainer-vector), Subresource Integrity where any external asset is unavoidable.
- **NFR-SEC5** Web hardening: TLS 1.3 + HSTS, strict CSP (no `unsafe-inline`), CSRF
  protection, rate limiting on all endpoints, input validation at every trust boundary,
  idempotency keys on any state-changing API.
- **NFR-SEC6** Infrastructure: CIS-benchmark-hardened host, least-privilege containers,
  encrypted backups with quarterly restore drills, centralized logs with integrity
  protection (daily Merkle root anchored on-chain, AR-6).
- **NFR-SEC7** Independent validation before real-money launch: at minimum automated DAST
  (OWASP ZAP) + dependency audit + an external review of the payment/settlement flow; a
  professional penetration test as soon as budget allows (flagged residual risk if
  deferred).
- **NFR-SEC8** Incident response plan incl. treasury-compromise runbook (pause, migrate
  multisig, disclosure duty per T&C) tested by tabletop exercise before Hedge launch.

### 2.2 Reliability, performance, cost (NFR-R/P/C)

- **NFR-R1** Monitor module availability target 99.5%; settlement jobs are at-least-once
  with idempotent effects and a catch-up scanner for missed expiries (no certificate may
  remain unsettled > 1 h past expiry under normal operation).
- **NFR-R2** Certificate/payment ledger: RPO ≤ 1 h (WAL/PITR), RTO ≤ 4 h; price cache
  loss is acceptable (rebuildable).
- **NFR-P1** Dashboard time-to-interactive < 3 s on a mid-range laptop; chart interactions
  < 100 ms; simulation limits per FR-S6 with queueing + progress feedback.
- **NFR-C1** Cost ceilings: one-time on-chain spend ≤ €50 (hard, see AR-6 cost table);
  recurring infrastructure ≤ ~€30/month at pilot scale; third-party APIs on free tiers
  until usage forces upgrades (upgrade triggers documented).

### 2.3 Quality, auditability, extensibility (NFR-Q/A/E)

- **NFR-Q1** The prototype's economic core is packaged once (`@lh/core`) and used by the
  web app, workers, and tests — a single source of truth; all 192 existing tests must
  remain green, and CI runs them on every change.
- **NFR-Q2** Property-based tests for every economic invariant (payoff bounds, premium
  floor, solvency, NAV consistency, value-neutrality) in addition to example-based tests;
  differential tests: platform quote/settle results ≡ prototype emulator results on the
  same inputs.
- **NFR-A1** Every state transition (quote → payment → activation → settlement) is an
  append-only audited event; the system state is replayable from the event log
  (extends `event-audit/`).
- **NFR-E1** The `RiskModel` port (AR-5) is versioned and stable from v1; model
  implementations are pure and deterministic (seeded), perform no I/O, and declare a
  config JSON schema — the exact properties needed to sandbox third-party models later
  (WASM, fuel-limited) without engine redesign.
- **NFR-U1** Accessibility WCAG 2.1 AA; responsive layout; light/dark themes; all charts
  readable in both (dataviz standards applied at implementation time).

## 3. Architectural Requirements (technology-agnostic)

- **AR-1** Hexagonal architecture: a pure domain core (pricing, pool accounting,
  certificate lifecycle, risk models — largely the existing `pricing-engine/`,
  `pool-manager/`, `orchestrator/certificates.ts`, `risk-analyser/`) surrounded by ports:
  MarketData, Chain (read + submit), Persistence, Clock, Notification. The prototype's
  component decomposition (market-data / pricing-engine / risk-analyser / orchestrator /
  pool-manager / position-escrow / event-audit / external-interface) **is retained as the
  service-module map** — it already matches this product almost 1:1.
- **AR-2** Deployment shape: modular monolith + separate worker processes (ingestion,
  regime updater, payment watcher, settler, simulation runners) sharing the domain
  package; seams chosen so any worker can be split out later. One small VPS must suffice
  at pilot scale (NFR-C1).
- **AR-3** State: replace the prototype's JSON `StateStore` with an ACID relational store
  + append-only event table; domain functions stay pure (state in → state out) exactly as
  in the prototype to preserve testability and replayability.
- **AR-4** Read path isolation: user-facing reads come from a query/cache layer; RPC and
  vendor APIs are accessed only by ingestion workers with budget-aware schedulers
  (rate-limit tiers, caching, exponential backoff — patterns already in
  `birdeye-adapter.ts`).
- **AR-5** `RiskModel` port: `describe() → {id, version, configSchema}`,
  `calibrate(series, config) → params`, `simulatePaths(params, horizon, steps, n, seed) →
  paths` (deterministic). GBM and EmpiricalBootstrap are the two v1 implementations;
  pricing quadrature consumes the same GBM parameters used by simulation (consistency).
- **AR-6** On-chain strategy (**€50 hard cap — custom programs excluded by cost**):
  - Deploying even a minimal custom Anchor program costs ~1.5–3 SOL in rent
    (≈ €190–420 at SOL ≈ $150, €1 ≈ $1.08) → **out of budget and out of scope for v1**.
  - Instead, trust anchors via existing audited programs:
    1. **Squads v4 multisig** treasury (creation ≈ 0.05–0.1 SOL);
    2. **SPL Memo anchoring**: T&C version hashes, per-certificate term-sheet hashes at
       issuance, and a daily Merkle root of the audit log (~0.000005 SOL per tx —
       negligible);
    3. USDC payments as plain SPL transfers with reference keys (ATA creation ≈ 0.002 SOL
       each);
    4. Optional compressed-NFT receipts (Bubblegum tree ≈ 0.1–0.35 SOL) — include only if
       the running total stays under budget.
  - Estimated one-time total without cNFTs: **≈ 0.1–0.2 SOL (€15–30)**; with cNFTs:
    ≈ 0.25–0.5 SOL — decision deferred to the live SOL price at deployment.
- **AR-7** Settlement price policy (must be fixed in the T&C, deterministic and
  replayable): primary = the pool's own `sqrtPrice` read at the first finalized slot at/after
  expiry (matches what the position economically experiences), cross-checked against an
  independent aggregator price; divergence > X bps triggers a documented fallback (short
  TWAP + manual review window). Every settlement stores slot, raw account data, and both
  prices.
- **AR-8** Payment reconciliation is exactly-once by construction: (quoteId → reference
  key → transfer signature) is a unique chain; activation is a single idempotent
  transactional step keyed on quoteId.
- **AR-9** The Monitor module must run with zero dependency on the Hedge module's services
  (separate processes/permissions), supporting P1 and the legal separation in FR-L1.

---

## §E. Evaluation pass — inconsistencies found and how requirements were corrected

| # | Issue found | Resolution |
|---|---|---|
| E1 | "ISO certification of absolute security per EU standards" — no such certification exists; ISO 27001 certifies an ISMS, not security itself; certification cost (€15–40k) exceeds the general budget | NFR-SEC1 rewritten: ASVS L2/L3 as the engineering standard + ISO 27001-*aligned*, certification-ready ISMS; EU frameworks mapped individually (GDPR, MiCA/MiFID II, NIS2/DORA n/a) |
| E2 | "No licenses needed + complete shelter via disclaimers" — the certificate is economically a cash-settled derivative; BVI SIBA/VASP and (if EU users) MiCA/MiFID II may apply regardless of drafting; liability for fraud/gross negligence cannot be disclaimed in essentially any jurisdiction | FR-L1/L2 + FR-H9 restructure the goal into *minimizing licensing triggers* (non-custodial Monitor module, bilateral OTC framing, geofencing, caps, invite-only pilot) with **counsel sign-off as a blocking gate**; residual risk explicitly owned by the operator |
| E3 | Signed-swap enforceability gap: the prototype settles the LP-owes-RT leg "physically from the escrowed position", but v1 has no escrow → upside leg would be uncollectible | FR-H3: buyer posts `Cap_up` in USDC as collateral at purchase (small by the convexity wedge); position escrow (and with it collateral-free purchases) deferred to a later on-chain phase |
| E4 | "All information the Orca front-end provides" implicitly includes accurate entry cost basis, which needs historical tx indexing — expensive at this budget | FR-M3: from-first-seen P&L + manual cost basis in v1; tx-history parsing later |
| E5 | Real-time expectations vs. free-tier RPC/API rate limits | FR-M7 sets explicit staleness tiers; AR-4 isolates all vendor access behind budget-aware ingestion |
| E6 | €50 on-chain budget vs. any custom program (≈ €190–420 rent alone) | AR-6: existing-programs-only strategy with itemized cost table; custom program explicitly out of scope v1 |
| E7 | Empirical Monte Carlo needs 1–3 y of clean history; single-vendor dependency (Birdeye) is a data risk; prototype already hardcodes fallbacks that would silently distort results (σ=20% default) | FR-M9 ingestion + retention + fallback source; silent fallbacks from the prototype must become **loud** (surfaced data-quality warnings, never silent substitution) |
| E8 | Multi-asset portfolios: independent per-asset GBM would misstate portfolio risk | FR-S2 requires joint modeling (block bootstrap / correlated GBM) |
| E9 | Prototype quirks that must not leak into the product: "Gauss-Hermite" naming for Simpson quadrature; self-referential severity feedback; dead heuristic FV; `Number(u128)` liquidity cast | Rename to `computeQuadratureFV` in `@lh/core`; severity feedback either wired to realized data or removed from the live path; heuristic FV excluded from the product API; liquidity normalized via BigInt with documented precision bounds |
| E10 | Settlement price source unspecified in the prototype for adversarial conditions | AR-7 defines a deterministic, documented oracle policy referenced by the T&C |
| E11 | Regime freshness (900 s) implies an always-on ops job the prototype doesn't have | FR-A2 + FR-A5 staleness alerting; quoting refuses stale regimes (already enforced in code) |
| E12 | **Found by model checking (2026-07-07, `platform/formal/`):** a headroom guard measured against the raw treasury balance counts unprocessed payments and held collateral as loss-absorbing reserves → exposure can exceed payable funds | FR-H6/AR-8 sharpened: utilization is checked against `treasury − unmatched payment float − active collateral` at BOTH quote and activation |
| E13 | **Found by model checking:** recording inflows in the audit ledger at activation (matching) time double-counts refunds of unmatched payments and breaks treasury reconciliation | NFR-A1/FR-A5 sharpened: the event ledger records inbound transfers at finalized OBSERVATION time; reconciliation asserts `treasury == initial + observed inflows − settlements − refunds` |
