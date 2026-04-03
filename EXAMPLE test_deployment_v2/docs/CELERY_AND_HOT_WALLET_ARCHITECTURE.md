# Celery Workers and Hot Wallet Architecture

## Table of Contents
1. [Celery Workers Overview](#1-celery-workers-overview)
2. [Why Celery is Needed](#2-why-celery-is-needed-in-this-project)
3. [Hot Wallet Creation Process](#3-hot-wallet-creation-process)
4. [Security Audit](#4-security-audit)
5. [Recommendations](#5-recommendations)

---

## 1. Celery Workers Overview

### What is Celery?

Celery is a distributed task queue system for Python. It allows you to run time-consuming operations asynchronously, outside of the HTTP request/response cycle.

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   FastAPI   │ ---> │    Redis    │ ---> │   Celery    │
│   (API)     │      │  (Broker)   │      │  (Worker)   │
└─────────────┘      └─────────────┘      └─────────────┘
     │                                           │
     │  HTTP Request                             │  Execute Strategy
     │  "Start Session"                          │  Loop (hours/days)
     │                                           │
     └── Returns immediately ──────────────────> └── Runs in background
```

### Key Components

| Component | Role | In This Project |
|-----------|------|-----------------|
| **Producer** | Creates tasks | FastAPI API endpoints |
| **Broker** | Message queue | Redis (stores pending tasks) |
| **Worker** | Executes tasks | Celery process running `strategy_tasks.py` |
| **Backend** | Stores results | Redis (stores task results/status) |

### How Tasks Work

```python
# In api/sessions.py - Producer
from tasks.strategy_tasks import run_user_strategy_session
task = run_user_strategy_session.delay(user_id, session_id)  # Non-blocking

# In tasks/strategy_tasks.py - Worker
@celery_app.task(bind=True, name="tasks.strategy_tasks.run_user_strategy_session")
def run_user_strategy_session(self, user_id: int, session_id: int):
    # This runs in a separate process, potentially for hours/days
    while session_is_active:
        check_position()
        maybe_rebalance()
        sleep(30)
```

---

## 2. Why Celery is Needed in This Project

### Problem: Long-Running Strategy Execution

The LP strategy requires **continuous monitoring** that runs for hours, days, or weeks:

```
┌──────────────────────────────────────────────────────────────┐
│                    Strategy Execution Loop                    │
├──────────────────────────────────────────────────────────────┤
│  1. Check current SOL/USDC price                             │
│  2. Check if position is in range                            │
│  3. Calculate if rebalance needed (ATR, skew, etc.)          │
│  4. Execute rebalance if conditions met                      │
│  5. Log metrics to database                                  │
│  6. Sleep for 30 seconds                                     │
│  7. Repeat forever until stopped                             │
└──────────────────────────────────────────────────────────────┘
```

### Why Not Just Use FastAPI?

| Approach | Problem |
|----------|---------|
| **Synchronous in request** | HTTP timeout after 30-60 seconds. User's browser would hang. |
| **Background thread** | Dies when API process restarts. No fault tolerance. |
| **asyncio.create_task()** | Same issue - tied to API process lifecycle. |
| **Celery Worker** | ✅ Independent process. Survives API restarts. Can scale horizontally. |

### Multi-User Scaling

With Celery, each user's strategy runs as an independent task:

```
┌─────────────────────────────────────────────────────────────┐
│                      Celery Workers                          │
├─────────────────────────────────────────────────────────────┤
│  Worker 1:  [User A Strategy] [User D Strategy]             │
│  Worker 2:  [User B Strategy] [User E Strategy]             │
│  Worker 3:  [User C Strategy] [User F Strategy]             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              Multiple workers = horizontal scaling
              Each task is isolated and fault-tolerant
```

### Task Types in This Project

| Task | Purpose | Duration |
|------|---------|----------|
| `run_user_strategy_session` | Main strategy loop | Hours/Days (long-running) |
| `cleanup_old_snapshots` | Database maintenance | Seconds (periodic) |
| `cleanup_expired_nonces` | Auth cleanup | Seconds (periodic) |
| `check_stale_sessions` | Health monitoring | Seconds (periodic) |

---

## 3. Hot Wallet Creation Process

### Overview

Each user gets a **dedicated hot wallet** for executing trades. This wallet is:
- Derived deterministically from a master seed (HD wallet pattern)
- Encrypted at rest in the database
- Only decrypted in memory when needed for transactions

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Hot Wallet Derivation                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   HD_WALLET_MASTER_SEED (64 bytes, from BIP-39 mnemonic)        │
│              │                                                   │
│              ▼                                                   │
│   ┌─────────────────────────────────────────────────┐           │
│   │  HMAC-SHA512(seed, "lp_platform:user:{index}")  │           │
│   └─────────────────────────────────────────────────┘           │
│              │                                                   │
│              ▼                                                   │
│   First 32 bytes = Private Key Seed                             │
│              │                                                   │
│              ▼                                                   │
│   Keypair.from_seed(private_key_seed)                           │
│              │                                                   │
│              ▼                                                   │
│   ┌─────────────────┐    ┌─────────────────────────┐           │
│   │  Public Key     │    │  Private Key            │           │
│   │  (stored plain) │    │  (encrypted with AES)   │           │
│   └─────────────────┘    └─────────────────────────┘           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Step-by-Step Process

#### Step 1: Get Master Seed
```python
def get_master_seed() -> bytes:
    seed_hex = os.getenv('HD_WALLET_MASTER_SEED')  # 64-byte hex string
    return bytes.fromhex(seed_hex)
```

#### Step 2: Derive User Keypair
```python
def derive_user_keypair(derivation_index: int) -> Keypair:
    master_seed = get_master_seed()

    # Create unique derivation path for this user
    derivation_data = f"lp_platform:user:{derivation_index}".encode()

    # HMAC-SHA512 produces 64 bytes
    derived = hmac.new(master_seed, derivation_data, hashlib.sha512).digest()

    # Use first 32 bytes as Ed25519 seed
    private_key_seed = derived[:32]

    # Create Solana keypair
    return Keypair.from_seed(private_key_seed)
```

#### Step 3: Encrypt Private Key
```python
def encrypt_private_key(private_key_bytes: bytes) -> str:
    # Derive Fernet key from master encryption key
    master_key = os.getenv('ENCRYPTION_MASTER_KEY')
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b'lp_strategy_multiuser_v1',  # Static salt
        iterations=100000,
    )
    fernet_key = base64.urlsafe_b64encode(kdf.derive(master_key.encode()))

    # Encrypt with Fernet (AES-128-CBC + HMAC-SHA256)
    fernet = Fernet(fernet_key)
    encrypted = fernet.encrypt(private_key_bytes)
    return base64.b64encode(encrypted).decode('utf-8')
```

#### Step 4: Store in Database
```python
hot_wallet = UserHotWallet(
    user_id=user_id,
    wallet_pubkey=str(keypair.pubkey()),        # Plain text (public)
    encrypted_private_key=encrypted_key,         # AES encrypted
    derivation_index=derivation_index,           # For recovery
)
db.add(hot_wallet)
await db.commit()
```

### Database Schema

```sql
CREATE TABLE user_hot_wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    wallet_pubkey VARCHAR(50) NOT NULL UNIQUE,      -- Solana address
    encrypted_private_key TEXT NOT NULL,            -- AES-encrypted
    derivation_index INTEGER NOT NULL UNIQUE,       -- For deterministic recovery
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 4. Security Audit

### 4.1 Strengths

| Aspect | Implementation | Assessment |
|--------|----------------|------------|
| **Key Derivation** | HMAC-SHA512 from master seed | ✅ Cryptographically sound |
| **Encryption Algorithm** | Fernet (AES-128-CBC + HMAC-SHA256) | ✅ Industry standard |
| **Key Stretching** | PBKDF2 with 100,000 iterations | ✅ Resistant to brute force |
| **Deterministic Recovery** | Derivation index stored | ✅ Can rebuild from master seed |
| **Memory Safety** | Keys decrypted only when needed | ✅ Minimizes exposure window |

### 4.2 Vulnerabilities and Concerns

#### CRITICAL: Static Salt in Key Derivation

```python
# In get_encryption_key()
salt = b'lp_strategy_multiuser_v1'  # ⚠️ STATIC SALT
```

**Risk**: All encryption keys derived from the same salt. If the master key is weak, rainbow table attacks become feasible.

**Recommendation**: Use a per-installation random salt stored separately, or include installation ID in salt.

#### HIGH: Master Seed Exposure

```python
seed_hex = os.getenv('HD_WALLET_MASTER_SEED')
```

**Risk**: If `HD_WALLET_MASTER_SEED` is compromised, ALL user wallets can be derived.

**Current Mitigations**:
- Stored as Fly.io secret (encrypted at rest)
- Never logged or exposed via API

**Recommendations**:
1. Consider Hardware Security Module (HSM) for production
2. Implement key rotation strategy
3. Add anomaly detection for unusual derivation patterns

#### MEDIUM: No Key Rotation

**Risk**: If encryption key is compromised, all historical encrypted keys are vulnerable.

**Recommendation**: Implement key versioning:
```python
class UserHotWallet:
    encryption_key_version: int  # Track which key version encrypted this
```

#### MEDIUM: Derivation Path Simplicity

```python
derivation_data = f"lp_platform:user:{derivation_index}".encode()
```

**Risk**: Predictable derivation paths. If an attacker knows the master seed and the pattern, they can derive any wallet.

**Assessment**: This is acceptable because:
1. The master seed is the true secret
2. The derivation index adds uniqueness
3. HMAC-SHA512 is a secure PRF

**Recommendation**: Consider adding a random component:
```python
derivation_data = f"lp_platform:user:{derivation_index}:{random_nonce}".encode()
```

#### LOW: Fernet Key Caching

```python
def get_encryption_key() -> bytes:
    # This is called every time - no caching
    kdf = PBKDF2HMAC(...)  # 100,000 iterations = ~100ms
```

**Issue**: Performance impact of repeated PBKDF2 derivation.

**Recommendation**: Cache the derived key in memory (with secure cleanup on shutdown).

### 4.3 Attack Vectors Analysis

| Attack Vector | Likelihood | Impact | Mitigations |
|---------------|------------|--------|-------------|
| **Database breach** | Medium | HIGH | Private keys are encrypted; attacker needs ENCRYPTION_MASTER_KEY |
| **Environment variable leak** | Low | CRITICAL | Use Fly.io secrets; never log env vars |
| **Memory dump** | Low | HIGH | Keys are in memory during execution; use secure memory practices |
| **Insider threat** | Low | CRITICAL | Limit access to production secrets; audit logging |
| **Replay attack on derivation** | N/A | N/A | Deterministic derivation is intentional for recovery |

### 4.4 Compliance Considerations

| Standard | Status | Notes |
|----------|--------|-------|
| **PCI-DSS** | Partial | Not handling card data, but key management practices apply |
| **SOC 2** | Partial | Encryption at rest ✅, audit logging needed |
| **GDPR** | N/A | Wallet addresses are pseudonymous, not PII |

---

## 5. Recommendations

### Immediate (Before Production)

1. **Add per-installation salt**
   ```python
   # Generate once on first deploy, store in separate secret
   INSTALLATION_SALT = os.getenv('INSTALLATION_SALT')
   salt = f'lp_strategy_{INSTALLATION_SALT}'.encode()
   ```

2. **Implement audit logging**
   ```python
   async def log_key_access(user_id: int, action: str):
       await db.execute(
           insert(AuditLog).values(
               user_id=user_id,
               action=action,
               timestamp=datetime.utcnow(),
               ip_address=request.client.host
           )
       )
   ```

3. **Add rate limiting on wallet creation**
   - Prevent enumeration attacks
   - Max 1 hot wallet per user

### Short-Term (1-3 months)

1. **Key rotation mechanism**
   - Version encryption keys
   - Background task to re-encrypt with new keys
   - Graceful migration path

2. **Enhanced monitoring**
   - Alert on unusual patterns (many derivations, failed decryptions)
   - Dashboard for key usage metrics

### Long-Term (6+ months)

1. **HSM integration** for master seed storage
2. **Multi-signature** for high-value operations
3. **Threshold cryptography** to split master seed across multiple parties

---

## Appendix: Environment Variables

| Variable | Purpose | Security Level |
|----------|---------|----------------|
| `HD_WALLET_MASTER_SEED` | Master seed for HD derivation | **CRITICAL** - Never expose |
| `ENCRYPTION_MASTER_KEY` | Key for encrypting private keys | **CRITICAL** - Never expose |
| `JWT_SECRET_KEY` | JWT signing key | HIGH - API authentication |
| `DATABASE_URL` | Database connection | HIGH - Contains credentials |
| `REDIS_URL` | Celery broker | MEDIUM - Internal only |

---

## Appendix: Recovery Procedure

If database is lost but secrets are preserved:

```python
# Recovery script
async def recover_all_wallets():
    for index in range(0, max_known_index + 1):
        keypair = derive_user_keypair(index)
        print(f"Index {index}: {keypair.pubkey()}")
        # Match against known user wallet addresses
```

This deterministic derivation means wallets can always be recovered from the master seed + derivation index.

---

*Document created: 2026-02-06*
*Last updated: 2026-02-06*
