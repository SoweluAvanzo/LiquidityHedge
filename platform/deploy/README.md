# Deployment — single hardened VPS (plan §1, NFR-C1 ≈ €10–17/mo)

Topology: **Cloudflare (DNS proxy, WAF, rate limiting) → Caddy (auto-TLS, reverse
proxy) → Next.js app container**. The app container is never published on the host;
only Caddy can reach it on the internal network.

## Container hardening (what's already in the compose file)

- Multi-stage image, production-only artifacts, **non-root** (`node`) user
- `read_only` root filesystem (tmpfs for `/tmp` and the Next cache), `cap_drop: ALL`,
  `no-new-privileges`, memory limits, `init: true`
- Health checks gate Caddy start; JSON logs with rotation
- Event-ledger persistence isolated in the `lh_data` volume (back it up — RB-6)
- Edge blocks `/api/hedge/dev/*` outright (defense-in-depth vs env misconfiguration);
  `HEDGE_DEV_MODE` is hard-pinned to `"0"` in the compose file
- Secrets only via `deploy/.env` (gitignored) — images contain no secrets

## First deployment

```bash
# On the VPS (Ubuntu 24.04):
#  - OS hardening per the checklist below, install Docker Engine + compose plugin
git clone <repo> && cd LiquidityHedge/platform/deploy
cp .env.example .env && $EDITOR .env       # domain + keys
docker compose up -d --build
docker compose --profile jobs run --rm regime-updater   # diagnostic, on demand (NOT on a 10-min cron — see P5)
```

Point the domain's DNS at the VPS through Cloudflare (proxied/orange cloud, SSL mode
"Full (strict)").

## Host checklist (NFR-SEC6 — do these before exposing port 443)

1. SSH: key-only, no root login, non-standard port optional; `ufw` allow 80/443/SSH only.
2. Unattended upgrades on; fail2ban for SSH.
3. Docker: keep the daemon local-only (no TCP socket).
4. Backups: nightly `docker run --rm -v lh-platform_lh_data:/d alpine tar czf - /d`
   → restic → offsite (B2); quarterly restore drill per RB-6.
5. Time sync (chrony) — settlement timestamps depend on it.

## Running locally (no TLS, port 8080)

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

Smoke checks:

```bash
curl -i http://localhost:8080/                 # 200, security headers + CSP present
curl -i http://localhost:8080/api/hedge/dev/x  # 403 (blocked at the edge)
```

## Known limitations (tracked)

- ~~No nonce-based CSP~~ **DONE 2026-07-08**: per-request nonce CSP via
  `src/proxy.ts` (`script-src 'nonce-…' 'strict-dynamic'`, no unsafe-eval in
  prod; connect-src limited to same-origin + the configured RPC host).
  Accepted residual: `style-src 'unsafe-inline'` for React inline style
  attributes (documented in proxy.ts). All pages render dynamically (nonce
  requirement). First activation immediately caught and removed a
  fonts.googleapis.com import shipped inside wallet-adapter-react-ui's CSS
  (now vendored clean at `src/styles/wallet-adapter.css` — re-vendor on
  dependency upgrades).
- The certificate ledger runs inside the web app as an event-sourced singleton —
  acceptable for the invite-only pilot behind a single replica; move it to its own
  service (same `@lh/hedge` core, Postgres event store) before scaling out. Do NOT
  run multiple web replicas while the ledger lives in-app (single-writer assumption).
- Rate limiting at the edge relies on Cloudflare; Caddy itself does not rate-limit.
