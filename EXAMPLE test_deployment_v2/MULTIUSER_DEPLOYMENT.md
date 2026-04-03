# Multi-User LP Strategy Platform Deployment Guide

This guide covers deploying the multi-user LP strategy platform to Fly.io.

## Architecture Overview

The platform consists of:
1. **Frontend** (Next.js) - User dashboard and wallet connection
2. **API** (FastAPI) - REST API and WebSocket server
3. **Workers** (Celery) - Background strategy execution
4. **PostgreSQL** - User data and session storage
5. **Redis** - Celery message broker and WebSocket pub/sub

## Prerequisites

- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account with billing enabled
- PostgreSQL and Redis instances on Fly.io

## Initial Setup

### 1. Create PostgreSQL Database

```bash
flyctl postgres create --name lp-strategy-db --region iad
```

Save the connection string for later.

### 2. Create Redis Instance

```bash
flyctl redis create --name lp-strategy-redis --region iad
```

Save the Redis URL for later.

### 3. Create Shared Volume

```bash
flyctl volumes create lp_multiuser_data --region iad --size 10
```

## Deploy API Service

### 1. Create the app

```bash
cd test_deployment_v2
flyctl apps create lp-strategy-api
```

### 2. Set secrets

```bash
# Database
flyctl secrets set DATABASE_URL="postgres://..." -a lp-strategy-api

# Redis
flyctl secrets set REDIS_URL="redis://..." -a lp-strategy-api
flyctl secrets set CELERY_BROKER_URL="redis://..." -a lp-strategy-api

# JWT Secret (generate a random 32-byte string)
flyctl secrets set JWT_SECRET_KEY="$(openssl rand -hex 32)" -a lp-strategy-api

# Encryption key for hot wallets
flyctl secrets set ENCRYPTION_MASTER_KEY="$(openssl rand -hex 32)" -a lp-strategy-api

# HD Wallet master seed (64 bytes / 512 bits)
# IMPORTANT: Generate this securely and back it up!
flyctl secrets set HD_WALLET_MASTER_SEED="$(openssl rand -hex 64)" -a lp-strategy-api

# Solana RPC
flyctl secrets set SOLANA_RPC_URL="your-rpc-url" -a lp-strategy-api

# API Keys
flyctl secrets set BIRDEYE_API_KEY="your-key" -a lp-strategy-api
flyctl secrets set JUPITER_API_KEY="your-key" -a lp-strategy-api
flyctl secrets set HELIUS_API_KEY="your-key" -a lp-strategy-api
```

### 3. Deploy

```bash
flyctl deploy -c fly-api.toml
```

## Deploy Celery Workers

### 1. Create the app

```bash
flyctl apps create lp-strategy-workers
```

### 2. Set secrets (same as API)

```bash
# Copy secrets from API app or set them individually
flyctl secrets set DATABASE_URL="postgres://..." -a lp-strategy-workers
flyctl secrets set REDIS_URL="redis://..." -a lp-strategy-workers
flyctl secrets set CELERY_BROKER_URL="redis://..." -a lp-strategy-workers
flyctl secrets set ENCRYPTION_MASTER_KEY="<same-as-api>" -a lp-strategy-workers
flyctl secrets set HD_WALLET_MASTER_SEED="<same-as-api>" -a lp-strategy-workers
flyctl secrets set SOLANA_RPC_URL="your-rpc-url" -a lp-strategy-workers
flyctl secrets set BIRDEYE_API_KEY="your-key" -a lp-strategy-workers
flyctl secrets set JUPITER_API_KEY="your-key" -a lp-strategy-workers
flyctl secrets set HELIUS_API_KEY="your-key" -a lp-strategy-workers
```

### 3. Deploy

```bash
flyctl deploy -c fly-workers.toml
```

## Deploy Frontend

### 1. Create the app

```bash
cd ../frontend
flyctl apps create lp-strategy-frontend
```

### 2. Deploy

The frontend is configured via build args in fly.toml.
Update the API and WebSocket URLs if using different app names.

```bash
flyctl deploy
```

## Database Migrations

Run migrations after deploying the API:

```bash
flyctl ssh console -a lp-strategy-api -C "cd /app && alembic upgrade head"
```

## Verify Deployment

1. **API Health**: https://lp-strategy-api.fly.dev/health
2. **API Docs**: https://lp-strategy-api.fly.dev/api/docs
3. **Frontend**: https://lp-strategy-frontend.fly.dev

## Monitoring

### View Logs

```bash
# API logs
flyctl logs -a lp-strategy-api

# Worker logs
flyctl logs -a lp-strategy-workers

# Frontend logs
flyctl logs -a lp-strategy-frontend
```

### View Metrics

```bash
flyctl status -a lp-strategy-api
flyctl status -a lp-strategy-workers
```

## Scaling

### Scale API

```bash
# Increase to 2 instances
flyctl scale count 2 -a lp-strategy-api
```

### Scale Workers

```bash
# Increase to 2 workers with more memory
flyctl scale count 2 -a lp-strategy-workers
flyctl scale memory 2048 -a lp-strategy-workers
```

## Security Checklist

- [ ] All secrets are set and not committed to git
- [ ] HD_WALLET_MASTER_SEED is backed up securely
- [ ] CORS_ORIGINS is set to production frontend URL only
- [ ] Database has connection limits configured
- [ ] Redis has authentication enabled
- [ ] API rate limiting is enabled
- [ ] Audit logs are being written

## Troubleshooting

### Worker not processing tasks

1. Check Redis connectivity:
   ```bash
   flyctl ssh console -a lp-strategy-workers -C "redis-cli -u $REDIS_URL ping"
   ```

2. Check Celery status:
   ```bash
   flyctl ssh console -a lp-strategy-workers -C "celery -A tasks.celery_app inspect ping"
   ```

### Database connection issues

1. Check DATABASE_URL is set correctly
2. Verify PostgreSQL app is running
3. Check connection pooling limits

### Frontend not connecting to API

1. Verify CORS_ORIGINS includes frontend URL
2. Check build args in fly.toml match API URL
3. Verify API is running and accessible

## Environment Variables Reference

### API Service

| Variable | Description | Required |
|----------|-------------|----------|
| DATABASE_URL | PostgreSQL connection string | Yes |
| REDIS_URL | Redis connection string | Yes |
| JWT_SECRET_KEY | Secret for JWT signing | Yes |
| ENCRYPTION_MASTER_KEY | Key for encrypting hot wallets | Yes |
| HD_WALLET_MASTER_SEED | Master seed for HD wallet derivation | Yes |
| SOLANA_RPC_URL | Solana RPC endpoint | Yes |
| BIRDEYE_API_KEY | Birdeye API key | Yes |
| JUPITER_API_KEY | Jupiter API key | Recommended |
| HELIUS_API_KEY | Helius API key | Recommended |
| CORS_ORIGINS | Allowed CORS origins | Yes |
| JWT_EXPIRY_HOURS | JWT token expiry (default: 24) | No |

### Workers

Same as API, plus:

| Variable | Description | Required |
|----------|-------------|----------|
| CELERY_CONCURRENCY | Number of concurrent tasks (default: 4) | No |

### Frontend

| Variable | Description | Required |
|----------|-------------|----------|
| NEXT_PUBLIC_API_URL | Backend API URL | Yes |
| NEXT_PUBLIC_WS_URL | WebSocket URL | Yes |
| NEXT_PUBLIC_SOLANA_NETWORK | Solana network (mainnet-beta) | No |
| NEXT_PUBLIC_SOLANA_RPC_URL | Solana RPC for wallet adapter | No |
