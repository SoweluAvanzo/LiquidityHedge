# 6. Implementation

## 6.1 Architecture Overview

The Liquidity Hedge Protocol is implemented in two layers:

1. **On-chain program**: An Anchor-based Solana smart contract (`lh_core`) that manages state, validates constraints, and executes settlements atomically.
2. **Off-chain emulator**: A TypeScript implementation (`OffchainLhProtocol`) that mirrors the on-chain logic for testing, simulation, and off-chain pricing.

Both layers implement the same `ILhProtocol` interface, ensuring behavioral equivalence:

```
interface ILhProtocol {
  // Pool management
  initPool(admin, config) -> PoolState
  depositUsdc(depositor, amount) -> { shares }
  withdrawUsdc(withdrawer, shares) -> { usdcReturned }
  
  // Position escrow
  registerLockedPosition(owner, params) -> void
  releasePosition(owner, positionMint) -> void
  
  // Pricing & regime
  createTemplate(admin, template) -> void
  updateRegimeSnapshot(authority, params) -> RegimeSnapshot
  
  // Certificates
  buyCertificate(buyer, params) -> BuyCertResult
  settleCertificate(settler, positionMint, price, fees) -> SettleResult
}
```

### 6.1.1 On-Chain Program (Anchor)

**Stack**: Anchor 0.31.1, Solana CLI 3.1.12 (Agave), platform-tools v1.52, Rust 1.94.1.

The on-chain program is organized into instruction modules:

| Module | Instructions | Description |
|--------|-------------|-------------|
| `pool/` | `initialize_pool`, `deposit_usdc`, `withdraw_usdc` | NAV-based pool management |
| `position_escrow/` | `register_locked_position`, `release_position` | NFT custody |
| `certificates/` | `buy_certificate`, `settle_certificate` | Certificate lifecycle |
| `pricing/` | `compute_quote`, `update_regime_snapshot`, `create_template` | Pricing engine |

### 6.1.2 Off-Chain Emulator — Component-Oriented Layout

**Stack**: TypeScript (Node 22), `ts-node`, Mocha/Chai test framework.

The emulator is organized as six named components plus two cross-cutting layers. Each component owns a single responsibility from §4's protocol flow, and the boundaries are chosen so that future migration to Anchor moves whole sub-trees rather than excavating from a monolith.

| Component | Directory | Responsibility |
|---|---|---|
| **Market Data Service** | `market-data/` | External data adapters (Birdeye OHLCV, future: Pyth, Deribit, Kamino) + Orca account decoders + CL math primitives |
| **Protocol Manager** → Orchestrator | `orchestrator/` | `OffchainLhProtocol` class (flow composer) + `ILhProtocol` facade for external callers |
| Orchestrator → **Certificate Lifecycle Manager** | `orchestrator/lifecycle/` | Time-driven flows: monitor loop, fee refresh, settlement with Theorem 2.2 assertion, Orca auto-close |
| **Protocol Manager** → Risk Analyser | `risk-analyser/` | Produces `RegimeSnapshot` (σ, IV/RV, stress, severity) from Market Data Service |
| **Pricing Engine** | `pricing-engine/` | Consumes `RegimeSnapshot + Position → QuoteResult` (FV quadrature, m_vol, P_floor, utilization guard, CL position-value math) |
| **Position Escrow** | `position-escrow/` | Orca instruction builders (open / increase / decrease / collect_fees / close) — the Anchor-port target |
| **Protection Pool Manager** | `pool-manager/` | RT deposit/withdraw, NAV share accounting, payout claims, fee-split distribution |
| **External Interface** (cross-cutting) | `external-interface/` | `ILhProtocol` — the public TS surface; HTTP API can plug in here later |
| **Event/Audit** (cross-cutting) | `event-audit/` | `StateStore` (JSON persistence), `AuditLogger` (JSONL), typed `ProtocolEvent` schemas (1:1 with future on-chain Anchor events) |

Source tree:

```text
protocol-src/
  external-interface/
    ilh-protocol.ts               ILhProtocol type + param shapes
  orchestrator/
    index.ts                      OffchainLhProtocol class + facade re-exports
    certificates.ts               buy + settle flow composition
    lifecycle/                    Certificate Lifecycle Manager
      index.ts                    barrel
      monitor.ts                  watchUntilExpiry()
      fee-refresher.ts            refreshAndReadFees() — real fee_owed via update_fees_and_rewards
      settle.ts                   settleAndAssert() — wraps settle with Theorem 2.2 check
      autoclose.ts                autoClosePosition() — decrease + collect + close + unwrap (atomic)
  risk-analyser/
    regime.ts                     updateRegime, severity calibration, IV/RV (scaffolded)
  pricing-engine/
    pricing.ts                    computeGaussHermiteFV, computePremium, computeHeuristicFV, computeQuote
    position-value.ts             V(S), lhPayoff (signed swap), naturalCap, naturalCapUp
  position-escrow/
    orca-adapter.ts               Orca ix builders: open/increase/decrease/collect_fees/close + WSOL wrap/unwrap
  pool-manager/
    pool.ts                       initPool, depositUsdc, withdrawUsdc, availableHeadroom
  market-data/
    birdeye-adapter.ts            OHLCV fetch + volatility computation
    decoder.ts                    Whirlpool + Position account decoders + CL math (sqrtPrice, ticks, estimateLiquidity)
  event-audit/
    store.ts                      StateStore (JSON persistence)
    logger.ts                     AuditLogger (JSONL append-only)
    events.ts                     Typed ProtocolEvent union + type guards (9 event types)
  types/
    constants.ts                  PPM / BPS / Q64 / DEFAULT_* governance
    pool.ts                       PoolState
    position.ts                   PositionStatus + PositionState
    certificate.ts                CertificateStatus + CertificateState + TemplateConfig + QuoteResult
    regime.ts                     RegimeSnapshot
    index.ts                      barrel
  config/
    chain.ts                      Program IDs + token mints + PDA derivation
    templates.ts                  DEFAULT_POOL_CONFIG + DEFAULT_TEMPLATE + computeBarrierFromWidth
  utils/
    math.ts                       Integer sqrt, tick/price conversions
  index.ts                        Barrel facade: export * from "./orchestrator"
```

The `OffchainLhProtocol` orchestrator additionally exposes `getEvents(): ProtocolEvent[]` — a typed, filterable event stream parallel to the AuditLogger's JSONL output. When the on-chain Anchor program ships, each event type has a 1:1 Rust counterpart in `programs/lh-core/src/events.rs`, so observers and dashboards share a vocabulary across the off-chain/on-chain boundary.

### 6.1.3 Future on-chain / off-chain split

Each component has a clear deployment target under the hybrid-devnet plan:

| Component | Where it runs in this PoC | Target under hybrid deployment |
|---|---|---|
| External Interface | TS import | Express API over mainnet/devnet RPC |
| Orchestrator + CLM | Node.js process | Node.js service + standalone lifecycle daemon (= `operator-service` on `offchain-emulator` branch) |
| Risk Analyser | Node.js process | Separate daemon posting `update_regime_snapshot` every \~10 min |
| Pricing Engine | Node.js process | Split: off-chain quadrature for quote; on-chain heuristic for enforcement |
| Position Escrow | In-memory flag | Mainnet Anchor program (`lh-escrow`, \~\$14 recoverable rent) |
| Pool Manager | In-memory | Devnet Anchor PDAs + mainnet custodial vault wallet |
| Market Data Service | Node.js process | Same (separate daemon) |
| Event/Audit | JSONL | On-chain Anchor events + JSONL query mirror |

## 6.2 State Accounts

### 6.2.1 Account Structures

Each protocol entity is stored as a Solana account (on-chain) or an in-memory object (emulator):

**PoolState** (single instance per protocol deployment):

| Field | Type | Scaling | Description |
|-------|------|---------|-------------|
| `reservesUsdc` | u64 | micro-USDC | Total USDC in vault |
| `totalShares` | u64 | raw count | Outstanding shares |
| `activeCapUsdc` | u64 | micro-USDC | Sum of active caps |
| `uMaxBps` | u16 | BPS | Max utilization |
| `markupFloor` | u64 | PPM | Min markup * PPM |
| `feeSplitRate` | u64 | PPM | Fee split * PPM |
| `premiumFloorUsdc` | u64 | micro-USDC | Premium floor |
| `protocolFeeBps` | u16 | BPS | Treasury fee |
| `bump` | u8 | -- | PDA bump seed |

**PositionState** (one per escrowed position):

| Field | Type | Scaling | Description |
|-------|------|---------|-------------|
| `positionMint` | Pubkey | -- | Orca position NFT mint |
| `owner` | Pubkey | -- | LP wallet |
| `entryPriceE6` | u64 | micro-USD | Entry price |
| `lowerTick` | i32 | tick index | Lower CL tick |
| `upperTick` | i32 | tick index | Upper CL tick |
| `liquidity` | u128 | raw | Liquidity parameter L |
| `entryValueE6` | u64 | micro-USDC | Position value at entry |
| `status` | u8 | enum | 1=Locked, 2=Released, 3=Closed |
| `protectedBy` | Option<Pubkey> | -- | Certificate mint (if protected) |
| `bump` | u8 | -- | PDA bump seed |

**CertificateState** (one per certificate):

| Field | Type | Scaling | Description |
|-------|------|---------|-------------|
| `positionMint` | Pubkey | -- | Protected position |
| `buyer` | Pubkey | -- | LP wallet |
| `entryPriceE6` | u64 | micro-USD | Price at purchase |
| `lowerBarrierE6` | u64 | micro-USD | Barrier = lower CL bound |
| `notionalUsdc` | u64 | micro-USDC | Position notional |
| `capUsdc` | u64 | micro-USDC | Natural cap |
| `premiumUsdc` | u64 | micro-USDC | Premium paid |
| `feeSplitRate` | u64 | PPM | Fee split frozen at purchase |
| `purchaseTs` | i64 | Unix seconds | Purchase timestamp |
| `expiryTs` | i64 | Unix seconds | Expiry timestamp |
| `state` | u8 | enum | 0=Created, 1=Active, 2=Settled, 3=Expired |
| `settlementPriceE6` | Option<u64> | micro-USD | Filled at settlement |
| `payoutUsdc` | Option<u64> | micro-USDC | Filled at settlement |
| `bump` | u8 | -- | PDA bump seed |

**RegimeSnapshot** (single instance per pool):

| Field | Type | Scaling | Description |
|-------|------|---------|-------------|
| `sigmaPpm` | u64 | PPM | 30-day annualized RV |
| `sigma7dPpm` | u64 | PPM | 7-day annualized RV |
| `stressFlag` | bool | -- | Stress regime indicator |
| `carryBpsPerDay` | u16 | BPS | Daily carry cost |
| `severityPpm` | u64 | PPM | Calibrated severity |
| `ivRvRatio` | u64 | PPM | IV/RV * PPM |
| `effectiveMarkup` | u64 | PPM | max(floor, IV/RV) * PPM |
| `updatedAt` | i64 | Unix seconds | Last update time |
| `bump` | u8 | -- | PDA bump seed |

**TemplateConfig** (one per product template):

| Field | Type | Scaling | Description |
|-------|------|---------|-------------|
| `templateId` | u32 | -- | Unique identifier |
| `widthBps` | u16 | BPS | Position width |
| `tenorSeconds` | u64 | seconds | Certificate duration |
| `premiumCeilingUsdc` | u64 | micro-USDC | Safety ceiling |
| `expectedDailyFeeBps` | u16 | BPS | Expected daily fee |

## 6.3 PDA Seeds

All protocol accounts are derived as Program Derived Addresses (PDAs) using deterministic seeds:

| Account | Seeds | Uniqueness |
|---------|-------|------------|
| PoolState | `[b"pool"]` | Singleton |
| USDC vault | `[b"pool_vault"]` | Singleton |
| Share mint | `[b"share_mint"]` | Singleton |
| PositionState | `[b"position", position_mint.key()]` | Per position |
| CertificateState | `[b"certificate", position_mint.key()]` | Per position |
| RegimeSnapshot | `[b"regime", pool.key()]` | Per pool |
| TemplateConfig | `[b"template", template_id.to_le_bytes()]` | Per template |

The deterministic derivation ensures that any party can compute the account address without on-chain lookups, enabling permissionless settlement.

## 6.4 Integer Arithmetic

### 6.4.1 Scaling Conventions

The protocol avoids floating-point arithmetic on-chain. All quantities use integer scaling:

- **PPM (parts per million, 10^6)**: Used for probabilities, volatility, ratios, severity. Example: `sigma = 65%` is stored as `sigmaPpm = 650,000`.
- **BPS (basis points, 10^4)**: Used for rates, utilization, width. Example: `width = +/-10%` is stored as `widthBps = 1,000`.
- **micro-USDC (10^6)**: All monetary values. Example: `$150.00` is stored as `150,000,000`.
- **Q64.64 (2^64)**: Sqrt-price representation for CL position math.

### 6.4.2 Overflow Protection

The heuristic FV computation involves multiplications of PPM-scaled values. The worst-case intermediate product is:

```
cap * p_hit * severity: up to 10^18 * 10^6 * 10^6 = 10^30
```

This exceeds `u64` range (`~1.8 * 10^19`) and requires `u128` (or BigInt in TypeScript). The protocol uses BigInt for all heuristic computations and performs division immediately after multiplication to keep intermediate values within bounds.

Example from the hit probability calculation:

```typescript
let pHitPpm = (900_000n * BigInt(sigmaPpm) * sqrtTPpm) / PPM_BI / widthPpm;
```

Each division by `PPM_BI` reduces the magnitude by 10^6.

### 6.4.3 Integer Square Root

The `integerSqrt` function computes `floor(sqrt(n))` for BigInt using Newton's method:

```typescript
function integerSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
```

Convergence is `O(log(log(n)))` iterations [13]. For `n < 2^128`, this requires at most 7 iterations.

## 6.5 On-Chain Patterns

### 6.5.1 Box<Account<>> for Large Structs

The `BuyCertificate` instruction context requires multiple accounts (pool, position, certificate, regime, template, vault, etc.). The combined struct size exceeds Solana's 4096-byte BPF stack frame limit. The pattern:

```rust
pub struct BuyCertificate<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, PoolState>>,
    pub regime: Box<Account<'info, RegimeSnapshot>>,
    // ... other accounts
}
```

`Box<Account<>>` heap-allocates the deserialized account data, keeping only an 8-byte pointer on the stack.

### 6.5.2 Borrow-Before-CPI

When a function needs to read immutable values and then perform a CPI (cross-program invocation), Rust's borrow checker requires careful ordering:

```rust
// Read immutable values BEFORE CPI
let bump = pool.bump;
let amount = pool.reserves_usdc;

// Perform CPI (takes &mut reference internally)
transfer_tokens(ctx, amount)?;

// Now safe to take &mut for state updates
let pool_mut = &mut ctx.accounts.pool;
pool_mut.reserves_usdc -= amount;
```

### 6.5.3 Init-If-Needed

The `RegimeSnapshot` account uses Anchor's `init_if_needed` attribute: the account is created on the first `update_regime_snapshot` call and reused for all subsequent updates. This avoids a separate initialization transaction.

## 6.6 Test Suite

The test suite covers five domains:

| Test File | Coverage |
|-----------|----------|
| `tests/unit/math.test.ts` | Integer sqrt, tick/price conversions, alignment |
| `tests/unit/pool.test.ts` | Deposit, withdraw, NAV pricing, utilization guard |
| `tests/unit/pricing.test.ts` | Premium formula, fee discount, heuristic FV, GH quadrature |
| `tests/unit/regime.test.ts` | Markup resolution, severity calibration, IV/RV, freshness |
| `tests/unit/certificates.test.ts` | Buy flow, settlement, payoff correctness, state transitions |

The test helpers (`tests/helpers.ts`) provide factory functions for creating test fixtures (`makePool`, `makeTemplate`, `makeRegime`, `makePosition`, `makeCertificate`) and simulation utilities (GBM path generation, fee simulation with deterministic pseudo-random number generation).

**Running tests:**

```bash
cd lh-protocol && yarn test            # all 148 tests
cd lh-protocol && yarn test:unit       # unit tests only
```

## 6.7 References for This Section

- [1] Adams, H. et al. (2021). "Uniswap v3 Core."
- [13] Press, W.H. et al. (2007). *Numerical Recipes*, 3rd ed.
- [21] Yakovenko, A. (2018). "Solana: A New Architecture for a High Performance Blockchain."
