# Multi-User LP Strategy Platform

## Overview

This document describes the multi-user extension to the SOL/USDC concentrated liquidity manager. The platform transforms the existing single-user strategy service into a multi-tenant platform where multiple users can:

1. Connect their Solana wallets and authenticate
2. Deposit funds to dedicated platform hot wallets
3. Configure and run personalized strategies
4. Monitor performance through a web dashboard

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           User's Browser                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Next.js Frontend (React + Tailwind + Solana Wallet Adapter)    │   │
│  │  - Wallet connection (Phantom, Solflare, Backpack, Ledger)      │   │
│  │  - Dashboard with portfolio overview                             │   │
│  │  - Strategy configuration                                        │   │
│  │  - Session management                                            │   │
│  │  - Real-time updates via WebSocket                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    HTTPS/WSS       │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Fly.io Infrastructure                           │
│                                                                          │
│  ┌────────────────────┐    ┌────────────────────┐                       │
│  │   FastAPI Server   │───▶│   Celery Workers   │                       │
│  │   (lp-strategy-api)│    │   (lp-strategy-    │                       │
│  │                    │    │    workers)        │                       │
│  │  - REST API        │    │                    │                       │
│  │  - SIWS Auth       │    │  - Strategy loop   │                       │
│  │  - WebSocket       │    │  - Position mgmt   │                       │
│  │  - Session mgmt    │    │  - Rebalancing     │                       │
│  └────────┬───────────┘    └─────────┬──────────┘                       │
│           │                          │                                   │
│           │         ┌────────────────┘                                   │
│           ▼         ▼                                                    │
│  ┌────────────────────┐    ┌────────────────────┐                       │
│  │    PostgreSQL      │    │       Redis        │                       │
│  │   (lp-strategy-db) │    │  (lp-strategy-     │                       │
│  │                    │    │   redis)           │                       │
│  │  - User accounts   │    │                    │                       │
│  │  - Configurations  │    │  - Celery broker   │                       │
│  │  - Sessions        │    │  - Task results    │                       │
│  │  - Positions       │    │  - Pub/sub for WS  │                       │
│  │  - Metrics         │    │                    │                       │
│  └────────────────────┘    └────────────────────┘                       │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │                    Persistent Volume                            │    │
│  │                   /data/users/{user_id}/                        │    │
│  │                                                                 │    │
│  │  - lp_management.csv      (position lifecycle)                  │    │
│  │  - asset_fees_management.csv (transactions)                     │    │
│  │  - pool_state_history.csv (pool metrics)                        │    │
│  └────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Solana Mainnet                                   │
│                                                                          │
│  ┌────────────────────┐    ┌────────────────────┐                       │
│  │   Orca Whirlpools  │    │      Jupiter       │                       │
│  │                    │    │                    │                       │
│  │  - SOL/USDC pool   │    │  - Token swaps     │                       │
│  │  - Position NFTs   │    │  - Best routes     │                       │
│  │  - Fee collection  │    │                    │                       │
│  └────────────────────┘    └────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Custody Model: Hybrid Custodial

The platform uses a **hybrid custodial** model:

1. **Authentication**: Users prove wallet ownership via SIWS (Sign In With Solana)
2. **Hot Wallets**: Each user gets a dedicated platform-managed hot wallet
3. **Deposits**: Users send SOL/USDC to their hot wallet address
4. **Execution**: Platform executes strategy automatically using the hot wallet
5. **Withdrawals**: Users can withdraw anytime (to their authenticated wallet only)

### Security Measures

- Hot wallet private keys encrypted at rest (Fernet/AES-256)
- Keys derived from master HD wallet (BIP-44 style derivation)
- Master seed stored as environment secret (never in code)
- Withdrawal whitelist enforced (user's own wallet only)
- Audit logs for all sensitive operations

## Components

### 1. Database Models (`app/db/models.py`)

New tables for multi-user support:

| Table | Purpose |
|-------|---------|
| `users` | User accounts linked to Solana wallet pubkeys |
| `user_hot_wallets` | Platform-managed hot wallets (encrypted keys) |
| `user_strategy_configs` | Per-user strategy parameters |
| `user_strategy_sessions` | Strategy session lifecycle tracking |
| `user_metric_snapshots` | Periodic portfolio snapshots for charts |
| `user_positions` | User-specific CLMM position tracking |
| `user_rebalances` | User-specific rebalance event logs |
| `user_daily_stats` | Per-user daily statistics and limits |
| `auth_nonces` | SIWS authentication nonces (short-lived) |
| `audit_logs` | Security audit trail |

### 2. User Context System (`test_deployment_v2/user_context.py`)

Provides isolated execution contexts per user:

```python
@dataclass
class UserContext:
    user_id: int
    wallet_pubkey: str          # User's main wallet (for auth)
    hot_wallet_keypair: Keypair # Platform hot wallet for execution
    hot_wallet_pubkey: str
    user_config: UserConfig     # User's strategy parameters
    config: Config              # Full config with user overrides
    session_id: Optional[int]
    data_dir: str               # User-specific CSV directory
```

**UserContextManager** handles:
- Loading user data from database
- Creating/deriving hot wallets (HD derivation)
- Caching active contexts
- Cleanup on session end

### 3. Authentication (`test_deployment_v2/api/auth.py`)

SIWS (Sign In With Solana) implementation:

```
1. Frontend: GET /api/auth/nonce {wallet_pubkey}
   Backend: Returns {nonce, message, expires_at}

2. Frontend: User signs message with wallet

3. Frontend: POST /api/auth/verify {wallet_pubkey, signature, nonce}
   Backend: Verifies Ed25519 signature, creates user if new
   Returns: {access_token (JWT), user_id, hot_wallet_pubkey}

4. Frontend: Includes JWT in Authorization header for all requests
```

### 4. API Layer (`test_deployment_v2/api/`)

FastAPI application with routes:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/auth/nonce` | Get nonce for SIWS |
| `POST /api/auth/verify` | Verify signature, get JWT |
| `GET /api/user/profile` | Get user profile + hot wallet |
| `PUT /api/user/profile` | Update email |
| `POST /api/user/hot-wallet` | Create hot wallet |
| `GET /api/strategy/configs` | List user's configs |
| `POST /api/strategy/configs` | Create config |
| `PUT /api/strategy/configs/:id` | Update config |
| `DELETE /api/strategy/configs/:id` | Delete config |
| `GET /api/sessions` | List sessions |
| `POST /api/sessions` | Start session (spawns Celery task) |
| `PUT /api/sessions/:id/pause` | Pause session |
| `PUT /api/sessions/:id/resume` | Resume session |
| `DELETE /api/sessions/:id` | Stop session |
| `GET /api/portfolio/summary` | Portfolio overview |
| `GET /api/portfolio/positions` | List positions |
| `GET /api/portfolio/rebalances` | List rebalances |
| `GET /api/portfolio/metrics/history` | Historical metrics |
| `GET /api/portfolio/export` | CSV download |
| `WS /ws/portfolio?token=` | Real-time updates |

### 5. Task Queue (`test_deployment_v2/tasks/`)

Celery with Redis for background execution:

**Strategy Task** (`run_user_strategy_session`):
- Loads user context (config, wallet)
- Runs strategy loop until stopped/paused
- Records metrics periodically
- Sends WebSocket updates
- Handles errors with retry logic

**Maintenance Tasks**:
- `cleanup_old_snapshots`: Remove old metric snapshots
- `cleanup_expired_nonces`: Remove expired auth nonces
- `check_stale_sessions`: Mark crashed sessions as error

### 6. Frontend (`frontend/`)

Next.js 14 application with:

- **Wallet Adapter**: Phantom, Solflare, Backpack, Ledger support
- **TanStack Query**: Data fetching with caching
- **Zustand**: Auth state management
- **Tailwind CSS**: Styling

**Pages**:
- `/` - Landing page with wallet connection
- `/dashboard` - Portfolio overview
- `/dashboard/positions` - Position tracking
- `/dashboard/strategy` - Configuration and session control
- `/dashboard/history` - Sessions and rebalances
- `/dashboard/settings` - Account settings

### 7. Multi-User Adapter (`test_deployment_v2/multiuser_adapter.py`)

Bridges multi-user system with existing single-user code:

```python
# Create all components for a user
components = await create_user_components(user_context, db_session)

# Use components with existing code
components.csv_logger.log_position_open(...)
await components.trade_executor.open_position(...)

# Sync to database
await sync_session_to_db(components, db, session_id)
await record_position_to_db(components, db, position_data, session_id)
```

## Configuration

### Strategy Parameters (Per-User)

Users can configure via the dashboard:

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| K Coefficient | 0.50-1.00 | 0.60 | Range width relative to ATR |
| Min Range | 1-15% | 3% | Minimum range width |
| Max Range | 2-20% | 7% | Maximum range width |
| ATR Period | 7-30 days | 14 | ATR calculation period |
| ATR Change Threshold | 5-50% | 15% | Trigger for range update |
| Max Rebalances/Day | 1-10 | 2 | Daily rebalance limit |
| Capital Deployment | 50-100% | 80% | % of wallet to deploy |
| Max SOL/Position | 0.1-100 | 1.0 | Per-position cap |
| Stop Loss Enabled | bool | false | Emergency protection |
| Stop Loss % | 1-50% | 10% | Trigger threshold |
| Check Interval | 10-300s | 30 | Monitoring frequency |

### Environment Variables

See `MULTIUSER_DEPLOYMENT.md` for complete list.

## Data Flow

### Starting a Session

```
1. User clicks "Start Strategy" in dashboard
2. Frontend: POST /api/sessions {config_id}
3. API creates UserStrategySession record (status: pending)
4. API dispatches Celery task: run_user_strategy_session(user_id, session_id)
5. Worker loads UserContext (config, wallet, CSV logger)
6. Worker updates session status to "running"
7. Worker enters strategy loop:
   - Check for pause/stop commands
   - Monitor position (if exists)
   - Open position (if none)
   - Rebalance (if needed)
   - Record snapshots
   - Send WebSocket updates
8. Loop continues until stopped/paused/error
```

### Real-Time Updates

```
Worker → Redis Pub/Sub → API WebSocket Handler → Browser
       channel: user:{user_id}:updates
```

## File Structure

```
test_deployment_v2/
├── api/                         # FastAPI application
│   ├── __init__.py
│   ├── main.py                  # App entry point, WebSocket
│   ├── auth.py                  # SIWS authentication
│   ├── users.py                 # User management
│   ├── strategy.py              # Strategy configs
│   ├── sessions.py              # Session lifecycle
│   └── portfolio.py             # Portfolio data
├── tasks/                       # Celery tasks
│   ├── __init__.py
│   ├── celery_app.py           # Celery configuration
│   └── strategy_tasks.py       # Background execution
├── user_context.py             # User context management
├── multiuser_adapter.py        # Bridge to existing code
├── config.py                   # Added factory method
├── csv_logger.py               # Added per-user logging
├── fly-api.toml                # API deployment
├── fly-workers.toml            # Workers deployment
├── Dockerfile.api              # API Docker image
├── Dockerfile.workers          # Workers Docker image
├── requirements.txt            # Updated dependencies
├── MULTIUSER_PLATFORM.md       # This document
└── MULTIUSER_DEPLOYMENT.md     # Deployment guide

frontend/
├── app/
│   ├── layout.tsx              # Root layout
│   ├── page.tsx                # Landing page
│   ├── globals.css             # Tailwind styles
│   └── (dashboard)/
│       ├── layout.tsx          # Dashboard layout
│       ├── page.tsx            # Overview
│       ├── positions/page.tsx
│       ├── strategy/page.tsx
│       ├── history/page.tsx
│       └── settings/page.tsx
├── components/                  # Reusable components
├── providers/
│   ├── WalletProvider.tsx      # Solana wallet adapter
│   └── QueryProvider.tsx       # TanStack Query
├── hooks/
│   └── useAuth.ts              # Auth hook + Zustand store
├── lib/
│   └── api.ts                  # API client
├── package.json
├── fly.toml
└── Dockerfile

app/db/
├── models.py                   # +10 new models
└── __init__.py                 # Updated exports

alembic/versions/
└── 20260123_0006_add_multi_user_tables.py
```

## Security Considerations

### Authentication
- SIWS provides cryptographic proof of wallet ownership
- JWTs expire after 24 hours (configurable)
- Nonces expire after 5 minutes, single-use

### Hot Wallet Security
- Private keys never stored in plaintext
- Fernet encryption with PBKDF2 key derivation
- Master seed in environment secrets only
- Derivation index ensures unique wallets

### API Security
- All endpoints require valid JWT (except auth)
- User isolation: queries always filter by user_id
- Audit logging for sensitive operations
- Rate limiting recommended (nginx/cloudflare)

### Data Isolation
- Each user has separate:
  - Hot wallet
  - Strategy configurations
  - Session history
  - Position tracking
  - CSV output directory

## Relationship to Existing Code

The multi-user platform is **additive** - it doesn't modify the existing single-user instances:

| Aspect | Single-User (Existing) | Multi-User (New) |
|--------|------------------------|------------------|
| Entry Point | `lp_strategy.py` | `api/main.py` + Celery workers |
| Configuration | Environment vars | Database + env vars |
| Wallet | Single `WALLET_PRIVATE_KEY_BASE58` | Per-user HD-derived |
| Data Storage | `/data/` | `/data/users/{user_id}/` |
| Session State | Global singleton | Per-user instances |
| Deployment | `fly.toml` | `fly-api.toml` + `fly-workers.toml` |

The existing `lp-strategy-v2` and `lp-strategy-v2-instance2` continue to run unchanged.

## Future Enhancements

1. **Withdrawal Flow**: Allow users to withdraw funds from hot wallet
2. **Email Notifications**: Per-user email alerts
3. **Strategy Templates**: Pre-configured strategies to choose from
4. **Performance Analytics**: Advanced charts and statistics
5. **Multi-Pool Support**: SOL/USDC with different fee tiers
6. **Mobile App**: React Native companion app
