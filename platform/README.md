# Liquidity Hedge Platform

Monorepo for the Liquidity Hedge product: a **Monitor & Simulate** module
(read-only Orca Whirlpool position analytics, Monte-Carlo simulation) and a
**Hedge** module (Liquidity Hedge certificates, signed-swap payoff).

Design documents live in [`../product-design/`](../product-design); the
economic core is extracted from the audited prototype in `../lh-protocol/`.

---

## Running the app

### 1. Dockerized stack — Caddy reverse proxy, production build (recommended)

```bash
cd /home/sowelo/Scrivania/LiquidityHedge/platform/deploy

# start (build + run in background)
docker compose -f docker-compose.yml -f compose.local.yml up -d --build

# → http://localhost:8080

# status / logs
docker compose -f docker-compose.yml -f compose.local.yml ps
docker compose -f docker-compose.yml -f compose.local.yml logs -f web

# stop
docker compose -f docker-compose.yml -f compose.local.yml down

# stop and also wipe data volumes (event ledger + snapshots)
docker compose -f docker-compose.yml -f compose.local.yml down -v
```

Configuration: `deploy/.env` (copy from `deploy/.env.example`). This stack runs
the app exactly as it deploys — non-root, read-only filesystem, nonce CSP,
dev endpoints blocked at the edge — plus the pool-snapshot collector.

**Hedging is disabled here by design** (`HEDGE_TREASURY_ADDRESS` empty,
`HEDGE_DEV_MODE` pinned `0`): the Monitor and Simulation modules work fully.
Set `HEDGE_TREASURY_ADDRESS` + `HEDGE_INITIAL_RESERVES_USDC` in `deploy/.env`
to enable it. See [`deploy/README.md`](deploy/README.md) for production
deployment (TLS, host hardening, backups).

### 2. Dev server — hot reload, hedge dev-mode available

```bash
cd /home/sowelo/Scrivania/LiquidityHedge/platform
pnpm install          # first time only
pnpm --filter @lh/web dev
# → http://localhost:3000   (Ctrl-C to stop)
```

Configuration: `apps/web/.env.local`. With `HEDGE_DEV_MODE=1` the purchase
flow exposes "Simulate payment" / "Settle due" buttons for end-to-end testing.

### First steps in the UI

Connect a wallet, or paste any address into **Watch address** — e.g.
`6A3JVW6LMuYE1eriipCPWchf1riGqem1cenpCyVMHAXj` (a wallet holding real Orca
positions) — then explore the position cards, the **Simulate** section
(GBM / empirical bootstrap / historical replay, with value / value+yield /
yield-only composition), and, in dev mode, **Hedge this position**.

---

## Development

```bash
pnpm -r test            # all package tests
pnpm -r typecheck       # all packages
pnpm --filter @lh/web build

# operational jobs
pnpm --filter @lh/ops-jobs regime-once        # regime update (σ, IV/RV) from live data
pnpm --filter @lh/ops-jobs snapshot-once      # one pool fee-growth + TVL snapshot
pnpm --filter @lh/ops-jobs data-report        # CSV export, dry run (writes to .data/reports)
RESEND_API_KEY=… pnpm --filter @lh/ops-jobs data-report --send   # email it
pnpm --filter @lh/ops-jobs devnet-rehearsal   # full money path on devnet
pnpm --filter @lh/ops-jobs drill-restore <events.jsonl>   # RB-6 restore drill

# formal model (Quint) — see formal/README.md
pnpm dlx @informalsystems/quint test formal/lh_ledger.qnt --main lh_ledger_tests
```

## Data the platform accumulates

| Dataset | Written by | Location (Docker volume) | Contents |
|---|---|---|---|
| Pool snapshots | `snapshot-collector` every 15 min, for **every Orca pool above `MIN_POOL_VOLUME_USD`** (default $10k 24h volume → ~107 pools) | `lh_snapshots` → `/snapshots/<pool>.snapshots.jsonl` + `tracked-pools.json` | price, active liquidity, feeGrowthGlobal A/B, **vault balances → exact on-chain TVL** |
| Pool overview | web app, on each viability computation | `lh_data` → `.data/pool-overview.jsonl` | vendor volume24h, TVL, fee tier, pool daily yield |
| In-range predictions | web app, on each viability computation | `lh_data` → `.data/inrange-predictions.jsonl` | empirical vs GBM in-range estimates (for predictive scoring) |
| Certificate ledger | web app, on every hedge transition | `lh_data` → `.data/hedge-events.jsonl` | event-sourced quotes, payments, settlements |

**Storage.** In production the collector writes to **PostgreSQL** (set
`DATABASE_URL`); with no `DATABASE_URL` it falls back to the file-backed dev
stores under `apps/web/.data/` and `platform/.data/pool-snapshots/`. The
database is deliberately hardened:

- **never published on the host** — it lives on an `internal: true` Docker
  network with no port mapping, so it is unreachable from outside the stack;
- **three least-privilege roles**: `lh_admin` (schema owner, migrations only),
  `lh_writer` (INSERT/SELECT — *no* UPDATE, DELETE or DDL), `lh_reader`
  (SELECT). The app and collector connect as `lh_writer`;
- **append-only enforced by the database**, not by convention — history
  cannot be rewritten even if the application is compromised;
- scram-sha-256 auth, per-role statement timeouts, connection limits,
  `cap_drop: ALL`, credentials only in the gitignored `.env`, and DSNs
  redacted in every log line;
- all queries are parameterized (no dynamic SQL anywhere in `@lh/storage`).

Apply the schema once after first start:

```bash
cd platform/deploy
PGPW=$(grep -oP '^POSTGRES_PASSWORD=\K.+' .env)
docker run --rm --network lh-platform_data \
  -v "$PWD/../packages/storage/src/schema.sql:/schema.sql:ro" \
  -e PGPASSWORD="$PGPW" postgres:16-alpine \
  psql -h postgres -U lh_admin -d lh -f /schema.sql
```

**Email export (every 2 days):**

```bash
cd platform/deploy
# set RESEND_API_KEY (+ REPORT_TO / REPORT_FROM) in .env, then:
docker compose -f docker-compose.yml --profile reports up -d data-reporter
```

Sends a summary plus one **CSV per dataset** (pool snapshots carry computed
`tvlUsd` and ISO timestamp columns) to `REPORT_TO`. Run
`pnpm --filter @lh/ops-jobs data-report` for a dry run that writes the same
CSVs to disk instead.

## Packages

| Package | Purpose |
|---|---|
| `packages/core` | Economic core extracted from the prototype: pricing, payoff, pool accounting, Orca decoding/instructions (parity-tested against `lh-protocol/`) |
| `packages/portfolio` | Position discovery, decimals-safe valuation, V(S) curves, viability index |
| `packages/market-data` | Paginated OHLCV ingestion with coverage guards, realized vol, pool fee-growth snapshots, in-range estimators |
| `packages/risk-models` | `RiskModel` port + GBM, empirical bootstrap, historical replay; portfolio Monte-Carlo engine with composable yield |
| `packages/hedge` | Certificate ledger (implements the verified formal model), quote/term-sheet service, settlement runner, chain adapters |
| `services/ops-jobs` | Regime updater, snapshot collector, devnet rehearsal, restore drill |
| `apps/web` | Next.js application (dashboard, simulation, purchase flow) |

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `RPC_URL` | server | Solana RPC (never exposed to the browser) |
| `NEXT_PUBLIC_RPC_URL` | browser | Public RPC for wallet connections (optional) |
| `BIRDEYE_API_KEY` | server | Market data (OHLCV, pool overview) |
| `HEDGE_TREASURY_ADDRESS` | server | Enables the Hedge module when set |
| `HEDGE_INITIAL_RESERVES_USDC` | server | Opening treasury reserves (µUSDC) |
| `HEDGE_PREMIUM_FLOOR_USDC` | server | P_floor, default `50000` = $0.05 |
| `HEDGE_PER_BUYER_CAP_USDC` | server | Per-wallet exposure cap (0 = none) |
| `HEDGE_TENOR_SECONDS` | server | Certificate tenor (default 604800 = 7 days) |
| `HEDGE_DEV_MODE` | server | `1` enables dev-only simulate/settle endpoints |
| `MIN_POOL_VOLUME_USD` | collector | Track every Orca pool with at least this 24h volume (default `10000`) |
| `MAX_TRACKED_POOLS` | collector | Hard cap on tracked pools (default `400`) |
| `TRACK_REFRESH_HOURS` | collector | How often the tracked set is rediscovered (default `24`) |
| `RESEND_API_KEY` / `REPORT_TO` / `REPORT_INTERVAL_HOURS` | reporter | CSV data export by email (default every 48 h) |
