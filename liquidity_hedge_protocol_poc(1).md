# Liquidity Hedge Protocol — Live Core PoC Specification

## 1. Purpose

This document specifies the **live core** of the Liquidity Hedge protocol: a smart-contract-based system that lets a liquidity provider (LP) open a **real Orca Whirlpool position** on **SOL/USDC**, lock the position while covered, buy an **NFT hedge certificate**, and transfer the downside risk of the position to a **risk taker** (RT) that supplies underwriting capital to a protection pool.

The purpose of the PoC is to implement the smallest subset that is still **live, end-to-end, and defensible** for the paper and for a first real demo:

- open a real Orca Whirlpool position
- escrow the position NFT while coverage is active
- quote a premium dynamically
- issue an NFT hedge certificate
- reserve bounded pool exposure
- collect premium and hold underwriting capital
- settle payout on-chain and release the position after expiry/settlement

This directly matches the paper's artifact goals: **position registration, tokenized position coverage issuance, collateral locking, premium accounting, payout execution**, with pricing based on **volatility, expected utilization, and time horizon**.

---

## 2. Protocol goal

The protocol exists to solve a gap in DeFi and concentrated liquidity provision:

- LP positions in CLMMs have **non-linear** payoff.
- Existing hedging methods often rely on **external derivatives markets** that may be unavailable or illiquid for many token pairs.
- Dynamic self-hedging strategies are operationally expensive and difficult to automate safely.

The protocol therefore provides a **direct risk-transfer layer** for CLMM positions:

- the **LP** buys protection on a live liquidity position,
- the **risk taker** earns premium income by absorbing bounded downside exposure,
- the protocol prices and routes the transfer in a transparent, deterministic, and auditable way.

### Strategic product value

Even in PoC form, the protocol adds real value because it introduces a **native, transferable hedge primitive for CLMM position equity**. That is stronger than “just” helping the user manage risk manually. It opens the path to:

- covered LP strategies
- underwriter yield products
- future leverage against protected positions
- composable CLMM risk-transfer instruments

### v1 design choice

To keep the PoC functional and implementable in one week, the live core will implement **one hedge product first**:

### Product A — Cash-settled capped corridor certificate

- bound to one live Orca position
- denominated and settled in **USDC**
- pays a bounded claim if the position hits or ends below the protected lower condition
- does **not** require native delta hedging or forced auto-close in v1

This is the fastest path to a usable and testable product. Product B (floor-at-lower-bound with auto-close) is reserved for v1.1.

---

## 3. Actors

### Liquidity Provider (LP)
- opens a real Orca Whirlpool position via the protocol
- locks the position NFT while protection is active
- pays a premium
- receives the hedge certificate NFT
- receives payout if the settlement condition is met

### Risk Taker (RT)
- deposits USDC into the protection pool
- receives pool shares
- earns premium income
- bears bounded loss through pool payouts

### Protocol Operator / Keeper
- opens and locks positions if the client workflow is server-assisted
- triggers settlement cycles
- synchronizes reserves and other operational flows

### Risk Service
- ingests market data
- computes regime state for pricing
- updates on-chain snapshot accounts used by quote verification

---

## 4. PoC scope

## 4.1 Included in the live core

1. **One token pair:** SOL/USDC
2. **One configured Orca Whirlpool**
3. **Live Orca position open** via official SDK
4. **Live position NFT lock** in protocol-controlled vault
5. **USDC-only protection pool**
6. **NFT hedge certificate issuance**
7. **Dynamic premium quoting**
8. **On-chain settlement** using Pyth
9. **Release of the locked position after settlement/expiry**

## 4.2 Deferred to v1.1+

1. Native lending / leverage engine
2. Loopscale integration for leverage
3. Product B floor-at-lower-bound with full forced auto-close
4. Secondary certificate market
5. Full fee harvest and fee-share routing from live positions
6. Governance console and broad admin UX
7. Arbitrage agent / market support logic

This keeps the PoC essential and live without overextending implementation risk.

---

## 5. Architecture

## 5.1 Components

The **PoC live core** has six components.

### A. Position Escrow Program (on-chain)

**Responsibility**
- open/import a real Orca Whirlpool position into protocol custody
- own the position NFT while a certificate is active
- expose position state and valuation inputs
- prevent unauthorized position mutation while protected
- release the position after settlement/expiry

**Why it is necessary**
Orca Whirlpool positions are represented as NFTs. Whoever holds the position token controls liquidity management, fee harvesting, and closure. The protocol therefore must custody the position token while the hedge is active.

### B. Certificate Engine (on-chain)

**Responsibility**
- instantiate a certificate bound to one escrowed position
- mint the certificate NFT
- activate coverage after payment
- store cap, template, expiry, and settlement state
- settle and coordinate payout with the pool

### C. Protection Pool (on-chain)

**Responsibility**
- accept underwriter USDC deposits
- mint pool shares
- reserve bounded exposure per certificate
- collect premiums
- pay claims
- enforce solvency through utilization caps

### D. Pricing Engine (on-chain)

**Responsibility**
- compute certificate quotes from position inputs, pool state, and risk regime inputs
- apply inventory/utilization overlays
- enforce deterministic quote bounds
- refuse issuance if the pool has insufficient headroom

### E. Market Data + Risk Service (off-chain)

**Responsibility**
- fetch market data (Birdeye and/or DEX/oracle references)
- compute volatility and other risk drivers
- publish authorized risk snapshots to chain

### F. Protocol Orchestrator (off-chain)

**Responsibility**
- coordinate open-and-lock transaction flow if server-assisted
- trigger settlement scans
- reconcile reserves and pool state
- run lifecycle jobs for the live core

---

## 5.2 Deployment model

For the first live core, the most practical deployment is:

### On-chain
**One Anchor program** named `lh_core`, with internal modules:
- `position_escrow`
- `certificates`
- `pool`
- `pricing`
- `state`
- `errors`
- `events`

This is preferred over multiple on-chain programs in week one because it:
- reduces CPI complexity,
- simplifies deployment and testing,
- keeps logical boundaries while minimizing operational overhead.

### Off-chain
Two services are sufficient:

1. **risk-service**
   - market data ingestion
   - volatility/stress computation
   - regime snapshot updates

2. **operator-service**
   - open-and-lock orchestration
   - settlement loop
   - reserve sync and operational tasks

Optional:
3. **thin API / CLI client**
   - useful for demos and scripted flows

---

## 6. Protocol design choices that improve the PoC

To maximize the chance of a functioning live implementation in one week, the design is intentionally conservative.

### 6.1 Use one underwriting asset only
The protection pool should be **USDC-only** in v1.

Reason:
- simpler reserve accounting
- cleaner payout semantics
- lower oracle risk
- easier solvency guarantees

### 6.2 Use one certificate product only
Implement **Product A** first:

**Cash-settled capped corridor certificate**
- pays a bounded USDC amount
- uses a lower protected condition and expiry
- does not require forced position close in v1

Reason:
- much simpler than full floor/auto-close
- still demonstrates transferable risk transfer
- keeps the position live and recoverable after settlement

### 6.3 Keep quote computation hybrid
Use:
- **off-chain analytics** for volatility and regime state
- **on-chain deterministic guards** for quote verification and solvency checks

Reason:
- keeps the on-chain program small and predictable
- still guarantees that quotes used in issuance are bounded and verifiable

### 6.4 Make leverage an extension, not a blocker
Although the long-term protocol should enable leveraged and hedged LP positions, the live PoC should not include native credit.

Reason:
- leverage adds debt state, liquidation state, and more timing complexity
- the paper’s core artifact does not require native leverage to be demonstrated in v1

Recommended extension path:
- v1.1: add **Loopscale adapter**
- v2: native leverage engine only after the hedge core is stable

---

## 7. Functional requirements

### FR1. Open a real Orca Whirlpool position for SOL/USDC
**Implementation**
- Use the official Orca TypeScript SDK to generate the position-open instructions.
- The transaction must open the position on the configured SOL/USDC Whirlpool.

### FR2. Lock the position NFT while coverage is active
**Implementation**
- Create the escrow PDA ATA for the position mint.
- Transfer the position NFT into the escrow ATA atomically with registration.
- `register_locked_position` must verify that the escrow vault now holds exactly one position token.

### FR3. Record the position state required for pricing and settlement
**Implementation**
Persist:
- owner
- whirlpool address
- position mint
- lower/upper ticks
- entry price `P0`
- deposited token amounts `x0`, `y0`
- protection state

### FR4. Allow risk takers to underwrite the pool
**Implementation**
- Accept USDC deposits into the pool vault
- Mint pool shares representing pro-rata ownership
- Maintain `reserves_usdc` and `active_cap_usdc`

### FR5. Quote a premium dynamically
**Implementation**
Price a quote from:
- position notional and bounds
- tenor
- volatility snapshot
- pool utilization
- stress/carry assumptions
- template floor/ceiling

### FR6. Reserve liability before certificate activation
**Implementation**
Before certificate activation:
- compute or validate `cap`
- ensure `active_caps + cap <= Umax * reserves`
- reserve the cap in pool state

### FR7. Issue an NFT hedge certificate
**Implementation**
- create certificate state
- mint an NFT or NFT-like receipt to the LP
- bind the certificate to the locked position
- mark the position as protected

### FR8. Collect premium into the protection pool
**Implementation**
- transfer premium in USDC from LP to pool vault
- record premium in certificate state
- increase reserves and activate coverage

### FR9. Execute settlement and payout on-chain
**Implementation**
- orchestrator scans active certificates
- certificate engine verifies expiry or barrier condition
- pool pays claim if due
- cap exposure is released

### FR10. Return the locked position after coverage ends
**Implementation**
- clear `protected_by` on the position
- transfer the position NFT back to the owner if policy allows

---

## 8. Non-functional requirements

### Correctness
- explicit state machines:
  - `PositionState`: `Open -> Locked -> Released | Closed`
  - `CertificateState`: `Created -> Active -> Settled | Expired`
- one active certificate per position in v1
- deterministic PDA and account validation

### Solvency
- reserve bounded exposure at issuance
- never exceed configured utilization
- settle from USDC-only reserves
- use conservative pricing/settlement assumptions

### Manipulation resistance
- use Pyth staleness checks for settlement
- use confidence intervals conservatively
- use minimum holding period between activation and settlement if needed

### Liveness
- critical instructions should be permissionless where safe
- operator-service should run settlement and sync loops continuously

### Modularity
- retain separate modules for escrow, certificates, pool, and pricing even inside one Anchor program

### Performance
- off-chain analytics for expensive market/risk calculations
- on-chain quote verification should remain O(1) in state accesses

### Auditability
Emit events for:
- position registered
- position locked
- quote computed
- certificate activated
- exposure reserved
- claim paid
- exposure released

### Upgradeability
- deploy as upgradeable Anchor program with multisig authority
- treat template changes as forward-only for new certificates

---

## 9. Interaction with external systems

## 9.1 Orca

### Open positions
Use the current Orca TypeScript SDK `openPosition(...)` flow for concentrated liquidity positions. Orca’s current docs show that the open flow returns `instructions`, a quote, `positionMint`, and a callback that can submit the transaction. The docs also note that Whirlpool positions can use Token-2022 NFTs. ([Orca: Open Position](https://docs.orca.so/developers/sdks/positions/open-position))

### Custody model
Orca documents that Whirlpool positions are represented by NFTs and that whoever holds the token can manage the position. That is why the protocol must hold the position token while coverage is active. ([Orca: Tokenized Positions](https://docs.orca.so/developers/architecture/tokenized-positions))

### Harvest and close
For v1.1, use Orca’s CPI examples and harvest docs to collect fees or close positions from the escrow authority. Orca documents CPI integration for Anchor and fee harvesting/position management flows. ([Orca: CPI Examples](https://docs.orca.so/developers/examples/cpi), [Orca: Harvest](https://docs.orca.so/developers/sdks/positions/harvest))

## 9.2 Pyth

Use Pyth for any settlement-critical price. Pyth’s best-practices documentation recommends:
- stale-price rejection,
- confidence-interval-aware valuation,
- delayed or bounded settlement for derivative-like contracts. ([Pyth Best Practices](https://docs.pyth.network/price-feeds/best-practices))

## 9.3 Birdeye

Use Birdeye off-chain for:
- OHLCV
- historical returns
- volatility computation
- optional volume-derived fee proxies

Birdeye should not be used as the final on-chain settlement oracle.

---

## 10. Pricing model

## 10.1 v1 product

### Product A — Cash-settled capped corridor certificate

This product is bound to one live Orca position and settles in USDC.

At minimum, the certificate stores:
- `position`
- `template_id`
- `premium`
- `cap`
- `lower_barrier`
- `expiry_ts`

### Why this product first
- simplest live risk-transfer primitive
- no dependence on external derivatives markets
- no forced delta hedging required
- no forced close required in v1

## 10.2 Quote formula

Use:

```text
Premium = clamp(E[Payout] + C_rep + C_cap + C_adv - R_fee, floor, ceiling)
```

Where:

```text
E[Payout] = Cap * p_hit(sigma, T, w) * severity(w, T)
```

```text
C_cap = Cap * lambda * (U_after / U_max)^p
```

```text
C_adv = Cap * eta * max(0, sigma / sigma_ma - 1)
```

`C_rep` is a conservative replication-cost proxy.  
`R_fee` is optional and should be set to `0` in the first live core unless fee harvesting is implemented.

### Runtime inputs
- `sigma`, `sigma_ma`, `stress`, `carry` from `RegimeSnapshot`
- `reserves`, `active_caps` from `PoolState`
- `P0`, `PL`, `tenor`, `template`, `notional` from `PositionState` and template config

## 10.3 How risk factors are measured

### Volatility (`sigma`)
Computed off-chain from Birdeye OHLCV or equivalent historical price series.

### Stress
Derived from:
- `sigma / sigma_ma`
- abnormal oracle behavior
- optional operator-defined stress flags

### Utilization (`U`)
Computed on-chain as:

```text
U = active_cap_usdc / reserves_usdc
```

### Time horizon (`T`)
Set by template (for example 7d or 30d)

### Width (`w`)
Set by template or derived from the locked position bounds

### Settlement price
Pyth on-chain, stale-checked, optionally using the conservative side of the confidence interval.

---

## 11. State model

## 11.1 PoolState

```rust
#[account]
pub struct PoolState {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub share_mint: Pubkey,
    pub reserves_usdc: u64,
    pub active_cap_usdc: u64,
    pub u_max_bps: u16,
    pub bump: u8,
}
```

## 11.2 PositionState

```rust
#[account]
pub struct PositionState {
    pub owner: Pubkey,
    pub whirlpool: Pubkey,
    pub position_mint: Pubkey,
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub p0_price_e6: u64,
    pub deposited_a: u64,
    pub deposited_b: u64,
    pub protected_by: Option<Pubkey>,
    pub status: u8,
    pub bump: u8,
}
```

## 11.3 CertificateState

```rust
#[account]
pub struct CertificateState {
    pub owner: Pubkey,
    pub position: Pubkey,
    pub template_id: u16,
    pub premium_usdc: u64,
    pub cap_usdc: u64,
    pub lower_barrier_e6: u64,
    pub expiry_ts: i64,
    pub state: u8,
    pub nft_mint: Pubkey,
    pub bump: u8,
}
```

## 11.4 RegimeSnapshot

```rust
#[account]
pub struct RegimeSnapshot {
    pub sigma_ppm: u64,
    pub sigma_ma_ppm: u64,
    pub stress_flag: bool,
    pub carry_bps_per_day: u32,
    pub updated_ts: i64,
    pub signer: Pubkey,
}
```

---

## 12. Core workflows

## 12.1 Underwriter flow

1. RT deposits USDC into the pool.
2. Program mints pool shares.
3. `reserves_usdc` increases.

## 12.2 LP open-and-hedge flow

1. Operator/client resolves the configured Orca SOL/USDC Whirlpool.
2. Build Orca `openPosition(...)` transaction.
3. In the same transaction:
   - open the Orca position,
   - create the escrow ATA for the position mint,
   - transfer the position NFT to the escrow ATA,
   - call `register_locked_position`.
4. Risk service has already published the latest `RegimeSnapshot`.
5. Pricing engine computes a quote.
6. LP accepts the quote and calls `buy_certificate`.
7. Certificate engine:
   - verifies the quote,
   - reserves exposure,
   - collects premium,
   - mints certificate NFT,
   - marks position protected.

## 12.3 Settlement flow

1. Operator scans active certificates.
2. For each due certificate:
   - load current Pyth price,
   - verify freshness and confidence conditions,
   - compute payout.
3. Certificate engine calls pool payout.
4. Pool pays claim and releases exposure.
5. Position escrow clears protection and returns the position NFT to the LP.

---

## 13. Step-by-step implementation plan

## Phase 0 — Stack and environment

Use:
- Anchor 0.31.0
- Solana CLI 2.1.0
- Orca Whirlpools SDK
- Orca CPI examples for later harvest/close
- Pyth for settlement
- Birdeye for historical OHLCV

Reason: Orca’s CPI examples explicitly list Anchor 0.31.0 with Solana CLI 2.1.0 as compatible without extra patching. ([Orca: CPI Examples](https://docs.orca.so/developers/examples/cpi))

## Phase 1 — Pool and state foundation

Implement:
- `PoolState`
- `PositionState`
- `CertificateState`
- `RegimeSnapshot`
- template config constants or accounts

Acceptance criteria:
- RT deposit/withdraw works
- pool share mint works
- exposure reservation / release works

## Phase 2 — Live Orca open-and-lock

Implement:
- client-side `openPosition(...)` builder using Orca SDK
- escrow vault ATA for Token-2022 position NFT
- `register_locked_position`

Acceptance criteria:
- open a real Orca position on devnet
- lock the position NFT into the escrow PDA vault
- `PositionState` is created and readable

## Phase 3 — Pricing Engine

Implement:
- quote instruction or quote verification path
- floor/ceiling enforcement
- utilization overlay
- quote expiry / quote hash if desired

Acceptance criteria:
- premium changes correctly with volatility, tenor, and utilization
- issuance refused when headroom exceeded

## Phase 4 — Certificate Engine

Implement:
- create certificate
- reserve exposure
- collect premium
- mint NFT
- attach certificate to position

Acceptance criteria:
- one LP can cover one live locked Orca position
- pool state updates correctly

## Phase 5 — Settlement

Implement:
- operator settlement loop
- Pyth stale/confidence guardrails
- payout execution
- release exposure
- release locked position

Acceptance criteria:
- end-to-end settlement works on devnet with a live locked position

## Phase 6 — Hardening

Implement if time allows:
- event completeness
- reserve reconciliation jobs
- fee sweep skeleton
- audit tests for quote monotonicity and cap constraints

---

## 14. Example implementation snippets

## 14.1 Live Orca open-and-lock transaction builder (TypeScript)

```ts
import { openPosition, setWhirlpoolsConfig } from '@orca-so/whirlpools';
import {
  createSolanaRpc,
  devnet,
  address,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/kit';
import { PublicKey } from '@solana/web3.js';

const ESCROW_AUTHORITY = new PublicKey(process.env.ESCROW_AUTHORITY!);
const LH_CORE_PROGRAM = new PublicKey(process.env.LH_CORE_PROGRAM!);

await setWhirlpoolsConfig('solanaDevnet');
const rpc = createSolanaRpc(devnet(process.env.RPC_URL!));
const whirlpool = address('3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt');

const { instructions: orcaIx, positionMint } = await openPosition(
  rpc,
  whirlpool,
  { tokenA: 1_000_000_000n },
  0.95,
  1.05,
  100,
  walletSigner,
);

const ownerAta = getAssociatedTokenAddressSync(
  new PublicKey(positionMint),
  walletSigner.address,
  false,
  TOKEN_2022_PROGRAM_ID,
);

const vaultAta = getAssociatedTokenAddressSync(
  new PublicKey(positionMint),
  ESCROW_AUTHORITY,
  true,
  TOKEN_2022_PROGRAM_ID,
);

const createVaultAtaIx = createAssociatedTokenAccountInstruction(
  walletSigner.address,
  vaultAta,
  ESCROW_AUTHORITY,
  new PublicKey(positionMint),
  TOKEN_2022_PROGRAM_ID,
);

const transferNftIx = createTransferCheckedInstruction(
  ownerAta,
  new PublicKey(positionMint),
  vaultAta,
  walletSigner.address,
  1n,
  0,
  [],
  TOKEN_2022_PROGRAM_ID,
);

const registerIx = buildRegisterLockedPositionIx({
  programId: LH_CORE_PROGRAM,
  owner: walletSigner.address,
  positionMint: new PublicKey(positionMint),
  whirlpool: new PublicKey(whirlpool),
  vaultAta,
});

const tx = new VersionedTransaction(
  new TransactionMessage({
    payerKey: walletSigner.address,
    recentBlockhash: (await rpc.getLatestBlockhash().send()).value.blockhash,
    instructions: [...orcaIx, createVaultAtaIx, transferNftIx, registerIx],
  }).compileToV0Message(),
);

tx.sign([walletSigner]);
await rpc.sendTransaction(tx).send();
```

## 14.2 Register locked position (Anchor)

```rust
pub fn register_locked_position(
    ctx: Context<RegisterLockedPosition>,
    p0_price_e6: u64,
    deposited_a: u64,
    deposited_b: u64,
    lower_tick: i32,
    upper_tick: i32,
) -> Result<()> {
    require_eq!(ctx.accounts.vault_position_ata.amount, 1, LhError::PositionNotLocked);

    let state = &mut ctx.accounts.position_state;
    state.owner = ctx.accounts.owner.key();
    state.whirlpool = ctx.accounts.whirlpool.key();
    state.position_mint = ctx.accounts.position_mint.key();
    state.lower_tick = lower_tick;
    state.upper_tick = upper_tick;
    state.p0_price_e6 = p0_price_e6;
    state.deposited_a = deposited_a;
    state.deposited_b = deposited_b;
    state.protected_by = None;
    state.status = 1;
    state.bump = ctx.bumps.position_state;
    Ok(())
}
```

## 14.3 Quote calculation (Anchor)

```rust
pub struct QuoteBreakdown {
    pub premium_usdc: u64,
    pub cap_usdc: u64,
    pub expected_payout_usdc: u64,
    pub capital_charge_usdc: u64,
    pub adverse_selection_usdc: u64,
    pub replication_cost_usdc: u64,
}

pub fn compute_quote(
    cap_usdc: u64,
    tenor_days: u32,
    width_bps: u16,
    pool: &PoolState,
    regime: &RegimeSnapshot,
) -> Result<QuoteBreakdown> {
    let reserves = pool.reserves_usdc.max(1) as u128;
    let active = pool.active_cap_usdc as u128;
    let cap = cap_usdc as u128;
    let u_after_ppm = ((active + cap) * 1_000_000u128) / reserves;
    let u_max_ppm = (pool.u_max_bps as u128) * 100u128;

    require!(u_after_ppm <= u_max_ppm, LhError::InsufficientHeadroom);

    let sigma_ppm = regime.sigma_ppm as u128;
    let tenor_ppm = ((tenor_days as u128) * 1_000_000u128) / 365u128;
    let sqrt_t_ppm = integer_sqrt(tenor_ppm * 1_000_000u128);
    let width_ppm = (width_bps as u128) * 100u128;

    let mut p_hit_ppm = (900_000u128 * sigma_ppm * sqrt_t_ppm)
        / 1_000_000u128
        / width_ppm;
    if p_hit_ppm > 1_000_000u128 {
        p_hit_ppm = 1_000_000u128;
    }

    let severity_ppm = 500_000u128;
    let expected_payout = (cap * p_hit_ppm * severity_ppm)
        / 1_000_000u128
        / 1_000_000u128;

    let capital_charge = (cap * u_after_ppm * u_after_ppm)
        / 1_000_000u128
        / 1_000_000u128
        / 5u128;

    let adverse = if regime.stress_flag { cap / 10u128 } else { 0 };

    let replication = (cap * regime.carry_bps_per_day as u128 * tenor_days as u128)
        / 10_000u128
        / 100u128;

    let premium = expected_payout + capital_charge + adverse + replication;

    Ok(QuoteBreakdown {
        premium_usdc: premium as u64,
        cap_usdc,
        expected_payout_usdc: expected_payout as u64,
        capital_charge_usdc: capital_charge as u64,
        adverse_selection_usdc: adverse as u64,
        replication_cost_usdc: replication as u64,
    })
}
```

## 14.4 Buy certificate (Anchor)

```rust
pub fn buy_certificate(
    ctx: Context<BuyCertificate>,
    template_id: u16,
    quote: QuoteBreakdown,
    expiry_ts: i64,
    lower_barrier_e6: u64,
) -> Result<()> {
    let position = &mut ctx.accounts.position_state;
    require!(position.protected_by.is_none(), LhError::AlreadyProtected);

    let pool = &mut ctx.accounts.pool_state;
    let after = pool.active_cap_usdc
        .checked_add(quote.cap_usdc)
        .ok_or(LhError::Overflow)?;
    let limit = (pool.reserves_usdc as u128 * pool.u_max_bps as u128 / 10_000u128) as u64;
    require!(after <= limit, LhError::InsufficientHeadroom);
    pool.active_cap_usdc = after;

    let cert = &mut ctx.accounts.certificate_state;
    cert.owner = ctx.accounts.buyer.key();
    cert.position = position.key();
    cert.template_id = template_id;
    cert.premium_usdc = quote.premium_usdc;
    cert.cap_usdc = quote.cap_usdc;
    cert.lower_barrier_e6 = lower_barrier_e6;
    cert.expiry_ts = expiry_ts;
    cert.state = 1;
    cert.nft_mint = ctx.accounts.cert_mint.key();
    cert.bump = ctx.bumps.certificate_state;

    position.protected_by = Some(cert.key());
    Ok(())
}
```

## 14.5 Settlement with Pyth guardrails (Anchor)

```rust
pub fn settle_certificate(ctx: Context<SettleCertificate>, now_ts: i64) -> Result<()> {
    let cert = &mut ctx.accounts.certificate_state;
    require!(cert.state == 1, LhError::NotActive);
    require!(now_ts >= cert.expiry_ts, LhError::TooEarly);

    let px = load_pyth_price(&ctx.accounts.pyth_price_feed, now_ts, 30)?;
    let price_e6 = normalize_pyth_to_e6(px.price, px.expo)?;
    let conf_e6 = normalize_pyth_to_e6(px.conf as i64, px.expo)? as u64;
    let conservative_downside = price_e6.saturating_sub(conf_e6);

    let payout = if conservative_downside <= cert.lower_barrier_e6 {
        cert.cap_usdc
    } else {
        0
    };

    let pool = &mut ctx.accounts.pool_state;
    if payout > 0 {
        pool.reserves_usdc = pool.reserves_usdc
            .checked_sub(payout)
            .ok_or(LhError::Underflow)?;
    }
    pool.active_cap_usdc = pool.active_cap_usdc
        .checked_sub(cert.cap_usdc)
        .ok_or(LhError::Underflow)?;

    cert.state = 2;

    let position = &mut ctx.accounts.position_state;
    position.protected_by = None;

    Ok(())
}
```

---

## 15. Detailed implementation guidance per component

## 15.1 Position Escrow Program

### What to implement first
- `register_locked_position`
- `getPosition`
- `getPositionValuationInput`
- `releasePosition`

### Internal modules
- `opening.rs`
- `custody.rs`
- `valuation.rs`
- `release.rs`

### Test cases
- rejects registration if vault does not hold position NFT
- rejects second active certificate on same position
- preserves owner and position metadata correctly
- releases only after certificate inactive

### Deployment notes
- deployed as part of `lh_core`
- no Fly deployment; it is on-chain
- operator-service must know the escrow PDA and ATA derivation scheme

## 15.2 Certificate Engine

### What to implement first
- `create_certificate`
- `buy_certificate`
- `settle_certificate`

### Internal modules
- `templates.rs`
- `minting.rs`
- `activation.rs`
- `settlement.rs`

### Test cases
- quote mismatch causes buy failure
- pool headroom exceeded causes buy failure
- payout cannot exceed cap
- settled certificate cannot settle twice

### Deployment notes
- deployed as part of `lh_core`
- metadata can be minimal in v1; a plain NFT receipt is acceptable

## 15.3 Protection Pool

### What to implement first
- `deposit_usdc`
- `withdraw_usdc`
- `reserve_exposure`
- `pay_claim`

### Internal modules
- `capital.rs`
- `exposure.rs`
- `claims.rs`
- `shares.rs`

### Test cases
- reserves update on deposits and payouts
- exposure reservation blocked above limit
- share minting and burning are correct
- claim payout releases exposure

## 15.4 Pricing Engine

### What to implement first
- `compute_quote`
- `verify_quote`
- quote bounds and refusal logic

### Internal modules
- `quote.rs`
- `regime.rs`
- `bounds.rs`
- `math.rs`

### Test cases
- premiums increase with sigma
- premiums increase with utilization
- premiums increase with tenor
- quote refused when `U_after > Umax`

## 15.5 Risk Service

### Responsibilities
- fetch Birdeye OHLCV
- compute realized sigma and sigma moving average
- determine stress flag
- publish `RegimeSnapshot`

### Suggested implementation
- TypeScript or Python service
- update every 5–15 minutes on devnet
- write signed/authorized transaction to `lh_core`

### Test cases
- snapshot freshness
- sigma calculation stable for flat markets
- stress flag turns on for configured threshold

## 15.6 Protocol Orchestrator

### Responsibilities
- monitor active certificates
- invoke settlement when due
- optionally reconcile pool reserves
- optionally drive fee sweep if implemented

### Suggested implementation
- worker process with polling loop
- idempotent jobs
- clear job logs and alerts

### Test cases
- settles expired certificate exactly once
- handles stale oracle by skipping and retrying
- does not brick if one certificate settlement fails

---

## 16. Fly.io deployment guide

The on-chain program is deployed to Solana and does **not** run on Fly.io. Fly.io is used for the **off-chain services**.

## 16.1 Recommended apps

Create two Fly apps:

1. `lh-risk-service`
2. `lh-operator-service`

This is simpler and more robust than combining everything into one worker during the PoC.

Fly’s current docs recommend:
- `fly launch` to create/configure a new app,
- `fly deploy` to deploy a Dockerfile-based application. ([Fly Launch](https://fly.io/docs/getting-started/launch/), [Fly Deploy](https://fly.io/docs/apps/deploy/))

## 16.2 risk-service deployment

### Purpose
- no public HTTP requirement in the minimal setup
- periodic worker updating regime snapshots

### Dockerfile

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
CMD ["node", "dist/risk-service/index.js"]
```

### fly.toml

```toml
app = "lh-risk-service"
primary_region = "fra"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"

[processes]
  app = "node dist/risk-service/index.js"
```

### Secrets

```bash
fly launch --no-deploy --name lh-risk-service
fly secrets set \
  BIRDEYE_API_KEY=... \
  RPC_URL=... \
  LH_PROGRAM_ID=... \
  REGIME_UPDATER_KEY_B64=...
fly deploy
```

### Notes
- no `[[services]]` block is required if this is a pure worker
- keep the updater key in Fly secrets, never in the image

## 16.3 operator-service deployment

### Purpose
- transaction builder for open-and-lock
- settlement and reserve-sync worker

### Dockerfile

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
CMD ["node", "dist/operator-service/index.js"]
```

### fly.toml

```toml
app = "lh-operator-service"
primary_region = "fra"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"

[processes]
  app = "node dist/operator-service/index.js"
```

### Secrets

```bash
fly launch --no-deploy --name lh-operator-service
fly secrets set \
  RPC_URL=... \
  LH_PROGRAM_ID=... \
  ORCA_WHIRLPOOL=... \
  PYTH_PRICE_FEED=... \
  OPERATOR_KEY_B64=...
fly deploy
```

### Notes
- this service is security-sensitive because it holds an operator key
- for PoC it can use a hot wallet with limited devnet funds
- for any serious environment, use HSM/KMS-backed signing or a delegated signer model

## 16.4 Optional API on Fly

If you want a thin API later:
- add a third app `lh-api`
- expose HTTP service with `[[services]]`
- point the frontend to it

## 16.5 Operational guidance

### Observability
Use:
- app logs in Fly
- structured JSON logs in both services
- basic health output and crash alerts

### Scaling
For the PoC:
- one machine per service is enough
- do not optimize prematurely

### Redundancy
Fly Launch may provision more than one machine depending on configuration. For worker-only services, keep deployment simple and manually control instance count. ([Fly Launch / Deploy](https://fly.io/docs/apps/deploy/))

---

## 17. Alternative cloud deployment options

If Fly.io proves inconvenient, use one of these alternatives.

### Railway
Best if you want the fastest container deployment with minimal infrastructure overhead.

### Render
Good for background workers and simple API services.

### Google Cloud Run
Good if you want production-grade IAM and service-account control quickly.

### Recommended fallback order
1. Fly.io
2. Railway
3. Cloud Run

---

## 18. Repository structure

```text
lh-protocol/
├── programs/
│   └── lh_core/
│       ├── src/
│       │   ├── lib.rs
│       │   ├── state.rs
│       │   ├── errors.rs
│       │   ├── events.rs
│       │   ├── position_escrow/
│       │   ├── certificates/
│       │   ├── pool/
│       │   └── pricing/
│       └── Cargo.toml
├── clients/
│   ├── operator-service/
│   ├── risk-service/
│   └── cli/
├── scripts/
│   ├── devnet-init.ts
│   ├── open-and-lock.ts
│   └── settle.ts
├── Anchor.toml
├── package.json
└── README.md
```

---

## 19. Acceptance criteria for the live core

The PoC is successful if all of the following are demonstrated on devnet:

1. A real Orca SOL/USDC position is opened.
2. The position NFT is transferred into protocol escrow.
3. A risk taker deposits USDC into the protection pool.
4. The protocol computes a quote using live risk snapshots.
5. The LP buys a certificate.
6. The pool reserves bounded exposure.
7. The certificate settles correctly at expiry or barrier condition.
8. The pool pays the claim or expires the certificate.
9. The position NFT is released back to the LP.

---

## 20. Roadmap after the PoC

### v1.1
- fee harvesting and fee-share routing
- Product B floor-at-lower-bound with forced close evidence
- stronger observability and dashboarding

### v1.2
- Loopscale adapter for leverage against external liquidity
- richer quote model and empirical calibration

### v2
- native leverage engine
- certificate secondary market
- multi-pair support
- underwriter tranching

---

## 21. Final implementation recommendation

Do **not** try to build the full protocol in week one.

Build the **live core** that proves the protocol’s thesis:
- **real Orca position opening**
- **real escrow of the position NFT**
- **USDC underwriting pool**
- **NFT-based protection certificates**
- **hybrid pricing with off-chain regime analytics and on-chain issuance guards**
- **Pyth-based settlement**
- **one token pair, one pool, one hedge product**

That is the shortest path to a functioning PoC that is technically sound, aligned with the paper, and expandable into the full product.
