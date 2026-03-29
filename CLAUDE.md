# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Liquidity Hedge Protocol — a Solana smart-contract-based system that lets a liquidity provider (LP) open a real Orca Whirlpool concentrated liquidity position on SOL/USDC, escrow the position NFT, buy an NFT hedge certificate, and transfer bounded downside risk to a risk taker (RT) who underwrites a USDC protection pool. The PoC implements **Product A: cash-settled capped corridor certificate** with **proportional payout** — a single hedge product on a single pair (SOL/USDC) with a single USDC-only pool.

The full specification is in `liquidity_hedge_protocol_poc(1).md`. The academic paper is `DLT2026_Paper_A-6.pdf`.

## Actual Stack

- **On-chain:** Anchor 0.31.1, Solana CLI 3.1.12 (Agave), platform-tools v1.52, Rust 1.94.1
- **Off-chain:** TypeScript (Node 22), `@coral-xyz/anchor` 0.31.1, `@solana/web3.js` v1.x, `@solana/spl-token` v0.4
- **Deployment:** Solana devnet (on-chain), Fly.io (off-chain services)

## Build & Test Commands

All commands run from `lh-protocol/` subdirectory:

```bash
anchor build                       # build the on-chain program → target/deploy/lh_core.so
anchor test                        # build + deploy to localnet + run Mocha tests
anchor deploy --provider.cluster devnet  # deploy to devnet
yarn install                       # install dependencies (uses yarn, not npm)
```

## Architecture

### On-chain: `lh-protocol/programs/lh-core/src/`

One Anchor program `lh_core` with internal modules:
- **pool/** — USDC protection pool: `initialize_pool`, `deposit_usdc`, `withdraw_usdc` (NAV-based share pricing)
- **position_escrow/** — custody of position NFTs: `register_locked_position`, `release_position`
- **certificates/** — NFT hedge certificates: `buy_certificate`, `settle_certificate` (proportional payout)
- **pricing/** — `compute_quote` (on-chain), `update_regime_snapshot`, `create_template`
- **state.rs** — `PoolState`, `PositionState`, `CertificateState`, `RegimeSnapshot`, `TemplateConfig`
- **constants.rs** — PDA seeds, Pyth staleness thresholds, PPM/BPS constants
- **math.rs** — `integer_sqrt` for fixed-point arithmetic
- **errors.rs** / **events.rs**

### Off-chain (planned): `clients/` and `scripts/`

- **risk-service** — Birdeye OHLCV → volatility → `RegimeSnapshot` publisher
- **operator-service** — settlement loop, reserve reconciliation
- **scripts/** — demo/devnet initialization scripts

## Key Implementation Patterns

- **Box<Account<>> for large structs** — `BuyCertificate` accounts exceed SBF 4096-byte stack limit; use `Box<Account<'info, T>>` to heap-allocate
- **Borrow-before-CPI** — read immutable values (bump, keys) before CPI calls, take `&mut` only after CPIs complete to avoid borrow checker conflicts
- **`init-if-needed`** on `RegimeSnapshot` — created on first `update_regime_snapshot` call
- **`idl-build` feature** must propagate to both `anchor-lang` and `anchor-spl`
- **u64 args in TypeScript** — always pass as `new anchor.BN(value)`, not raw numbers

## PDA Seeds

- `PoolState`: `[b"pool"]`
- USDC vault: `[b"pool_vault"]`
- Share mint: `[b"share_mint"]`
- `PositionState`: `[b"position", position_mint.key()]`
- `CertificateState`: `[b"certificate", position_mint.key()]`
- `RegimeSnapshot`: `[b"regime", pool.key()]`
- `TemplateConfig`: `[b"template", template_id.to_le_bytes()]`

## Key Design Decisions

- **Proportional payout** (not binary): `payout = min(cap, max(0, (barrier - price) * notional / barrier))`
- **NAV-based pool shares**: premiums increase `reserves_usdc` → share value rises; withdrawals guarded by utilization constraint
- **On-chain TemplateConfig**: admin-created accounts for product parameters (tenor, width, severity, floor/ceiling)
- **Entry price verification** against Pyth (planned ±5% tolerance)
- **Pyth** for settlement prices with staleness (30s) + confidence interval checks
- **Settlement is permissionless** — anyone can call `settle_certificate` for liveness

## State Machines

- `PositionState.status`: `Locked (1) -> Released (2) | Closed (3)`
- `CertificateState.state`: `Created (0) -> Active (1) -> Settled (2) | Expired (3)`

## Quote Formula

```
Premium = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling)
```
- `E[Payout] = Cap * p_hit(σ, T, width) * severity_ppm / PPM²`
- `C_cap = Cap * (U_after / PPM)² / 5` — quadratic utilization charge
- `C_adv = Cap / 10` if stress_flag, else 0
- `C_rep = Cap * carry_bps * tenor_days / BPS / 100`
- Floor/ceiling from `TemplateConfig`

## Critical Invariants

- Escrow vault must hold exactly 1 position NFT before `register_locked_position` succeeds
- `active_cap + new_cap <= U_max * reserves / 10_000` must hold before certificate activation
- Settlement uses conservative price: `price_e6 - conf_e6`
- Position NFT cannot be released while `protected_by` is set
- `post_withdrawal_reserves >= active_cap * 10_000 / u_max_bps` for RT withdrawals

## Reference Implementation: `test_deployment_v2/`

**DO NOT MODIFY** this directory. It is a read-only reference — a production Orca Whirlpools LP bot (Python/FastAPI) used as a source of patterns for integrating with real Orca Whirlpools.

### What to use from it

- **Orca interaction patterns:** `app/chain/orca_client.py` (pool state fetching, position discovery, open/close lifecycle)
- **Instruction building:** `app/chain/whirlpool_instructions.py` (Anchor discriminators, tick array derivation, Token2022 support)
- **Transaction management:** `app/chain/transaction_manager.py` (signing, retry logic)
- **API keys & addresses (from `.env`):**
  - Helius RPC: `https://mainnet.helius-rpc.com/?api-key=2ef5fdd0-5c3b-4ae1-a2fc-e12b3fd605e7`
  - Birdeye: `ed577a4a6a4f480fa659b4f18673e4b1`
  - Jupiter: `63dadbb1-483c-409d-9205-84c9935af09d`
  - SOL/USDC Whirlpool pool: `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`
  - Whirlpool program ID: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
  - SOL mint: `So11111111111111111111111111111111111111112`
  - Mainnet USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

### Key Orca constants from reference

- **Tick spacing:** 64 (for 1% fee tier SOL/USDC pool)
- **Tick array size:** 88 ticks per array
- **Tick bounds:** MIN_TICK = -443636, MAX_TICK = 443636
- **Position PDA:** `[b"position", position_mint]` under Whirlpool program
- **Tick array PDA:** `[b"tick_array", whirlpool, start_tick_index_string]` under Whirlpool program
- **Price math:** `price = 1.0001^tick * 10^(decimals_a - decimals_b)` → for SOL/USDC: `price = 1.0001^tick * 1000`
