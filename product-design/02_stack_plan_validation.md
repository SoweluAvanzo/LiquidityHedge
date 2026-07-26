# LH Product — Stack, Prioritization, Implementation Plan & Validation (v0.2)

Companion to `01_requirements.md`. Stages: technology stack → stack-dependent requirements
→ prioritization → implementation plan → plan evaluation & refinement → validation strategy
(testing + formal verification) → budgets.

---

## 1. Technology stack (chosen *after* the technology-agnostic requirements)

Selection principle: **one language end-to-end (TypeScript)** so the audited `protocol-src/`
core is reused verbatim, the team stays small, and the same domain code runs on server,
workers, and (for small simulations) in the browser.

| Layer | Choice | Rationale |
|---|---|---|
| Domain core | **`@lh/core`** = extracted `protocol-src/` (TS, Node 22) | 192 passing tests come for free; pricing, payoff, pool, regime, decoder, fee math, Orca ix builders all reused |
| Monorepo | pnpm workspaces + Turborepo | cheap, standard |
| Frontend | **Next.js (React, TS)**, Tailwind CSS | SSR for public/transparency pages, SPA dashboard |
| Wallets | Solana **Wallet Standard** via wallet-adapter; SIWS message auth | FR-W1/W2; broadest wallet coverage today; revisit ConnectorKit/framework-kit when stabilized |
| Charts | TradingView **lightweight-charts** (time series) + **visx** (fan charts, distributions, payoff diagrams) | performant, small, fully self-hosted (CSP-clean) |
| API | **Fastify + tRPC** (typed end-to-end), zod validation | lean; no schema drift between FE/BE |
| DB | **PostgreSQL 16** (native partitioning for candles) + **Drizzle** migrations | ACID ledger (AR-3); Timescale unnecessary at pilot scale |
| Jobs/queues | **BullMQ + Redis** | ingestion, regime updater, payment watcher, settler, sim runners (AR-2) |
| Simulation | Node **worker_threads** pool; hot loops in plain typed arrays; same core compiled to WASM/browser for small client-side runs | FR-S6 envelope is comfortably reachable; keeps the future WASM-sandbox path natural (NFR-E1) |
| Chain access | **Helius free tier** (dev) → paid only when rate limits force it; `@solana/web3.js` v1 retained at the boundary (core already uses it), new read paths may use `@solana/kit` behind the Chain port | AR-4 budget tiers |
| Market data | Birdeye (existing adapter + key), Binance options adapter (existing); fallback candle source: CoinGecko/Pyth history via the MarketData port | FR-M9, §E7 |
| Treasury | **Squads v4** multisig + capped hot wallet | FR-A3, AR-6 |
| Hosting | **Hetzner VPS** (CX32-class, ~€8–15/mo), Docker Compose, **Caddy** (auto-TLS), **Cloudflare** free (DNS/WAF/rate limit) | NFR-C1 |
| Observability | Sentry (free tier), Prometheus + Grafana (self-host) or Grafana Cloud free, Uptime-Kuma | FR-A5 |
| Backups | nightly `pg_dump` + WAL archiving via restic → Backblaze B2 (~€1/mo), quarterly restore drills | NFR-R2 |
| CI/CD | GitHub Actions: typecheck, lint, unit+property tests, legacy 192-test suite, dependency & secret scan (osv-scanner + gitleaks), semgrep, ZAP baseline on staging | NFR-SEC4/7, NFR-Q1 |
| Formal verification | **Quint** (TLA+-family) + Apalache model checker | see §6.3 |

## 2. Stack-dependent requirements (SR)

- **SR-1** Node 22 LTS pinned; TS `strict`; no `any`/implicit casts inside `@lh/core` and
  the settlement path; `BigInt` for all token amounts at boundaries — `Number()` casts of
  u128 liquidity (prototype quirk E9) are confined to a documented conversion helper with
  range checks.
- **SR-2** All tRPC procedures validated with zod on input **and** output; every
  state-changing procedure takes an idempotency key (NFR-SEC5, AR-8).
- **SR-3** BullMQ job ids are deterministic natural keys (`settle:{certId}`,
  `activate:{quoteId}`) — retries cannot double-execute (AR-8, NFR-R1).
- **SR-4** DB schema: `events` table is append-only (no UPDATE/DELETE grants for the app
  role); certificate/payment tables carry FK chains quote→payment→certificate→settlement;
  daily Merkle root of `events` computed by a job and anchored via Memo (AR-6, NFR-A1).
- **SR-5** Next.js: no third-party scripts; CSP nonce-based; wallet-adapter bundled and
  self-hosted; `next/image` only with local assets (NFR-SEC4/5).
- **SR-6** Ingestion workers enforce vendor budgets in code (token-bucket per API key);
  data-quality flags propagate to the UI ("degraded data" banners) — silent-fallback ban
  (§E7).
- **SR-7** Legacy suite: `yarn test` (192 tests) wired into CI against `@lh/core` after
  extraction; extraction PR must show zero behavioral diff (differential test harness).
- **SR-8** Hot wallet runs in a separate container with a distinct DB role, an outbound
  allowlist (RPC only), and a balance-cap reconciler that alerts and halts payouts on
  breach (FR-A3, NFR-SEC3).

## 3. Prioritization (MoSCoW → phases)

**Must (pilot cannot exist without):** FR-W1..4, FR-M1/M2/M4/M5/M7, FR-S1/S2(core)/S3/S4,
FR-H1..H9, FR-L1..L5, FR-A2..A5, NFR-SEC1..8, NFR-R1/R2, NFR-C1, NFR-Q1/Q2, NFR-A1,
AR-1..AR-9.

**Should (pilot is much better with):** FR-M3 (first-seen P&L), FR-M6, FR-M8 (viability
index), FR-S2 (full granularity incl. correlation), FR-A1, NFR-P1, NFR-U1.

**Could (defer freely):** FR-M9 ≥3 y retention (start with what vendors give), FR-H10
cNFT receipts, FR-L6 ticketing tooling (a mailbox + tracked sheet suffices at pilot),
client-side WASM sims.

**Won't (v1):** custom on-chain program, position escrow/custody, non-USDC stablecoins,
user-submitted risk models (only the port ships), historical tx-parsing cost basis,
ISO 27001 external certification audit.

## 4. Implementation plan (v2 — after refinement pass in §5)

Assumes ~1 senior full-stack dev (+ founder for ops/legal), part-time counsel. Weeks are
effort-calendar estimates at pilot quality, not guarantees.

**Phase 0 — Foundations & de-risking (wk 1–2)** → *Gate G0*
- Monorepo; extract `@lh/core` from `protocol-src/` (rename `computeGaussHermiteFV` →
  `computeQuadratureFV`; quarantine heuristic FV; BigInt boundary per SR-1); port all 192
  tests + differential harness (SR-7); CI with security scanners.
- **Engage BVI counsel now** (longest lead time; scope = FR-L1/L2).
- STRIDE threat model of the target architecture; data-vendor spike: verify Birdeye
  historical depth (1–3 y candles) for target tokens + fallback source (E7).
- *G0 exit:* core extracted with zero diff, counsel engaged, vendor plan proven.

**Phase 1 — Monitor MVP, deployed (wk 3–6)** → *Gate G1: public read-only launch*
- Wallet connect + SIWS; position discovery & decoding; position/portfolio dashboard;
  V(S) payoff curves; price ingestion + candle store; ops skeleton (Sentry, uptime,
  backups); hardening baseline (CSP, rate limits, headers).
- *G1 exit:* ASVS L2 self-assessment on the read-only surface; counsel confirms Monitor
  module is safely outside licensing perimeters (expected: yes, it's read-only software).

**Phase 2 — Simulation & analytics (wk 7–10)**
- `RiskModel` port + GBM + empirical bootstrap (IID + block); joint multi-asset handling;
  simulation workers + queue; config UI (schema-driven per FR-S5); fan charts,
  distributions, VaR/CVaR, hedged-vs-unhedged comparison; viability index (FR-M8);
  reproducibility store (FR-S4); property-based tests on models (§6.2).

**Phase 3 — Formal modeling & hedging design freeze (wk 11–12)** → *Gate G2*
- Quint model + Apalache checking of the certificate/payment/settlement state machine and
  solvency invariants (§6.3) **before** any real-money code is finalized.
- Freeze: settlement oracle policy (AR-7), collateral flow (FR-H3), refund policies,
  treasury design (FR-A3); tabletop incident exercise (NFR-SEC8).
- *G2 exit:* model checker green on all invariants; counsel draft terms received.

**Phase 4 — Hedging pilot build (wk 13–17)** → *Gate G3: real-money go-live*
- Quote service on `@lh/core` `computeQuote` + regime updater job (FR-A2); term-sheet
  generator + hash anchoring; USDC payment watcher with reference keys (AR-8); certificate
  ledger + lifecycle; settler worker + Theorem 2.2 runtime assertion; Squads treasury +
  capped hot wallet (SR-8); transparency pages (FR-H7/H8); geofencing + sanctions
  screening + caps + invite-only (FR-H9); devnet end-to-end rehearsal, then
  mainnet dry run with internal wallets (€ cents).
- *G3 exit (all blocking):* counsel sign-off on terms & perimeter; DAST + external review
  of payment/settlement path (NFR-SEC7); all invariant monitors live (FR-A5); restore
  drill passed; kill switch tested.

**Phase 5 — Pilot operation & hardening (wk 18–20)**
- Invite-only pilot with global exposure cap (e.g. ≤ $5k Σ Cap_down); daily reconciliation
  reports; pen-test scheduling when budget allows; FR-M3/M6/M8 polish; performance pass
  (NFR-P1).

**Phase 6 — Beta & extensibility groundwork (wk 21+)**
- Open beta (per counsel guidance); optional cNFT receipts if AR-6 budget allows at the
  live SOL price; WASM build of `RiskModel` implementations behind the same port —
  the seam future third-party models will use; evaluate custom on-chain escrow program as
  a *funded* milestone (explicitly out of the €50 envelope).

## 5. Plan evaluation & refinement (how v1 became v2)

| Weakness in draft v1 | Refinement applied in v2 |
|---|---|
| Formal verification placed after launch ("validate later") | Moved to **Phase 3, before hedging is built** — model checking is cheapest before code exists and is a G2 blocker |
| Legal engagement started at the hedging phase | Moved to **Phase 0** — counsel lead time is the critical path for G3, and perimeter advice shapes FR-H9 geofencing early |
| Payment activation treated as an ordinary feature | Elevated to a formally modeled, exactly-once flow (AR-8/SR-3) — it's the single highest-risk concurrency point (double-activation = double liability) |
| No explicit mainnet rehearsal | Added devnet e2e + cent-scale mainnet dry run to Phase 4 (the repo's live-orca script proves this pattern works) |
| Vendor risk (Birdeye historical depth) discovered late | Pulled into Phase 0 as a spike; fallback source is a G0 exit criterion |
| Hot-wallet automation vs. multisig latency unresolved | Resolved as capped float + threshold queue (FR-A3, SR-8) |
| cNFT receipts inflated Phase 4 scope | Deferred to Phase 6, conditional on the AR-6 budget table at live prices |
| "Pen test before launch" unaffordable → plan stalls | Replaced by layered G3 evidence (DAST + external flow review + monitors) with professional pen test as the first funded follow-up; residual risk documented and accepted explicitly |

Residual risks accepted at pilot: no professional pen test at G3 (mitigated by caps +
invite-only + monitors); single-operator ops (mitigated by runbooks + kill switch);
counterparty concentration disclosed to users (FR-H7).

## 6. Validation strategy

### 6.1 Testing pyramid
- **Unit:** all `@lh/core` behavior (existing 192 tests + new model/adapters tests).
- **Property-based (fast-check):** payoff ∈ [−Cap_up, +Cap_down] ∀ inputs; Premium ≥
  P_floor; premium monotonicity in σ; NAV share conservation; solvency after any op
  sequence; simulation determinism (same seed ⇒ same paths); GBM simulator statistics vs.
  closed-form moments; bootstrap preserves marginal moments within tolerance.
- **Differential:** platform quote/settle ≡ prototype emulator on randomized inputs
  (protects the extraction, SR-7); Simpson FV vs. high-N Monte Carlo within 0.1%.
- **Integration:** payment watcher vs. a local validator (bankrun/LiteSVM) with adversarial
  cases: wrong amount, wrong mint, missing reference, duplicate transfer, reorg-like
  re-delivery.
- **E2E (Playwright):** connect → view portfolio → simulate → quote → pay (devnet USDC) →
  activate → expire → settle → receipt.
- **Security:** ZAP baseline per deploy; gitleaks/osv-scanner/semgrep in CI; manual
  checklist from ASVS L2/L3 for auth, payments, treasury.

### 6.2 Runtime verification (production invariants, FR-A5)
Theorem 2.2 residual per settlement (already implemented in `lifecycle/settle.ts` — reuse);
solvency check after every ledger mutation; payment↔certificate reconciliation sweep;
oracle divergence guard; hot-wallet balance cap. Any violation: alert + auto-pause quoting
(never pause settlement payouts).

### 6.3 Formal verification (scoped to be achievable on this budget)
- **What:** a Quint specification of the *protocol ledger*: quote issuance, payment
  observation, activation, expiry, settlement, refund, pause — plus pool accounting.
- **Invariants checked (Apalache):**
  1. Solvency: `reserves ≥ Σ potential RT-side obligations` under `U_max` at all states;
  2. No double activation for one quote; no activation without matched finalized payment;
  3. Every Active certificate reaches exactly one of {Settled, Expired}; funds conservation
     (no USDC created/destroyed by the ledger);
  4. Kill switch never strands owed funds (liveness under fairness assumptions);
  5. Collateral safety: LP-owed leg never exceeds posted `Cap_up`.
- **What is *not* formally verified** (honest scope): floating-point quadrature accuracy
  (covered by differential tests §6.1), web/infra security (covered by §6.1/ASVS), and
  legal enforceability (counsel).
- Trace-check bridge: production event-log traces replayed against the Quint model in CI
  (model-based trace conformance) — catches drift between spec and implementation.

## 7. Budget summary

**One-time on-chain (hard cap €50; assumptions: SOL ≈ $150, €1 ≈ $1.08 → €50 ≈ 0.36 SOL):**

| Item | Est. SOL | Est. € |
|---|---|---|
| Squads v4 multisig + vault | 0.05–0.10 | €7–14 |
| Treasury ATAs (USDC ×2) | ~0.004 | <€1 |
| Memo anchoring (T&C hashes, daily roots, per-cert hashes; ~1k txs) | ~0.005 | <€1 |
| Dry-run transactions | ~0.02 | ~€3 |
| Buffer | 0.05 | €7 |
| **Total (base)** | **≈ 0.13–0.18** | **≈ €18–26** ✅ |
| Optional: Bubblegum cNFT tree (~16k receipts) | +0.1–0.35 | +€14–49 → only if total stays ≤ €50 at live prices |
| Custom Anchor program (for reference — excluded) | 1.5–3 | €190–420 ❌ |

**Recurring (pilot):** VPS €8–15, backups ~€1, domain ~€1, Cloudflare/Sentry/Grafana free
tiers, RPC free tier → **≈ €10–17/month**, ceiling €30 (NFR-C1). Known upgrade triggers:
Helius paid (~$49/mo) and Birdeye paid tier when polling volume grows — both usage-driven.

**Non-infra:** BVI counsel (the dominant real cost — obtain quotes early, Phase 0);
professional pen test deferred/funded later; ISO 27001 certification audit deferred.
