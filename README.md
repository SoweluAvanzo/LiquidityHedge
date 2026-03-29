# Liquidity Hedge Protocol

A Solana smart-contract-based system that lets a liquidity provider (LP) hedge the downside risk of a concentrated liquidity position on Orca Whirlpools. The protocol escrows the position NFT, issues an NFT hedge certificate, and routes bounded risk to a risk taker (RT) who underwrites a USDC protection pool.

The PoC implements **Product A: cash-settled capped corridor certificate** — a single hedge product on a single pair (SOL/USDC) with proportional payout and a USDC-only underwriting pool.

## How It Works

1. **LP opens** a real Orca Whirlpool concentrated liquidity position (SOL/USDC).
2. **LP locks** the position NFT into the protocol's escrow vault.
3. **LP buys** a hedge certificate — the protocol quotes a dynamic premium based on volatility, utilization, and tenor.
4. **RT deposits** USDC into the protection pool and receives pool shares (NAV-based pricing).
5. On expiry or settlement trigger, **anyone can call** `settle_certificate` (permissionless liveness).
6. If the settlement price (Pyth oracle, conservative = price - confidence) breaches the barrier, the certificate pays out proportionally up to the cap.
7. The position NFT is released back to the LP.

### Payout Formula

```
payout = min(cap, max(0, (barrier - price) * notional / barrier))
```

### Premium Quote

```
Premium = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling)
```

Where `E[Payout]` is the expected loss, `C_cap` is a quadratic utilization charge, `C_adv` is a stress surcharge, and `C_rep` is a carry cost. Floor and ceiling are set per product template.

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| On-chain program | Anchor (Rust) | 0.31.1 |
| Solana CLI | Agave | 3.1.12 |
| Platform tools | Solana platform-tools | v1.52 |
| Rust | rustc | 1.94.1 |
| Off-chain clients | TypeScript (Node.js) | 22 |
| Anchor TS SDK | @coral-xyz/anchor | 0.31.1 |
| Web3 | @solana/web3.js | 1.x |
| SPL Token | @solana/spl-token | 0.4 |
| Oracle | Pyth Network | — |
| AMM | Orca Whirlpools | — |
| Deployment target | Solana devnet | — |

## Repository Structure

```
LiquidityHedge/
├── lh-protocol/                        # Anchor workspace (on-chain + off-chain)
│   ├── programs/lh-core/src/           # Solana program source
│   │   ├── pool/                       #   USDC protection pool (init, deposit, withdraw)
│   │   ├── position_escrow/            #   Position NFT custody (lock, release)
│   │   ├── certificates/               #   Hedge certificate lifecycle (buy, settle)
│   │   ├── pricing/                    #   Quote engine, regime snapshots, templates
│   │   ├── state.rs                    #   Account structs (PoolState, CertificateState, …)
│   │   ├── constants.rs                #   PDA seeds, thresholds, PPM/BPS constants
│   │   ├── math.rs                     #   Fixed-point arithmetic (integer_sqrt)
│   │   ├── errors.rs                   #   Custom error codes
│   │   ├── events.rs                   #   Anchor events
│   │   ├── pyth.rs                     #   Pyth oracle helpers
│   │   └── orca.rs                     #   Orca Whirlpool struct definitions
│   ├── tests/                          # Mocha integration tests
│   ├── clients/                        # Off-chain services (TypeScript)
│   │   ├── risk-service/               #   Volatility → RegimeSnapshot publisher
│   │   ├── operator-service/           #   Settlement loop, reserve reconciliation
│   │   └── cli/                        #   Admin CLI
│   ├── scripts/                        # Devnet/mainnet initialization scripts
│   ├── Anchor.toml                     # Anchor config (localnet + devnet)
│   └── package.json
├── test_deployment_v2/                 # Reference: Orca Whirlpools LP bot (Python)
│   └── (read-only — patterns for Orca integration)
├── liquidity_hedge_protocol_poc(1).md  # Full PoC specification
├── DLT2026_Paper_A-6.pdf              # Academic paper
├── CLAUDE.md                           # AI assistant project context
└── contribution_guide.md               # Contribution guidelines
```

## On-Chain Program Modules

| Module | Instructions | Purpose |
|--------|-------------|---------|
| **pool** | `initialize_pool`, `deposit_usdc`, `withdraw_usdc` | USDC protection pool with NAV-based share pricing |
| **position_escrow** | `register_locked_position`, `release_position` | Custody of Orca position NFTs |
| **certificates** | `buy_certificate`, `settle_certificate` | Hedge certificate lifecycle and payout |
| **pricing** | `compute_quote`, `update_regime_snapshot`, `create_template` | Dynamic premium computation |

## Key Design Decisions

- **Proportional payout** (not binary) — fairer for partial price moves.
- **NAV-based pool shares** — premiums increase share value; withdrawals are guarded by utilization constraints.
- **Permissionless settlement** — anyone can call `settle_certificate` for liveness guarantees.
- **On-chain TemplateConfig** — admin-created product templates control tenor, width, severity, floor/ceiling.
- **Pyth oracle** with staleness (30s) and confidence interval checks for settlement prices.
- **Conservative settlement price** — uses `price - confidence` to protect the LP.

## Build and Test

All commands run from the `lh-protocol/` directory:

```bash
# Install dependencies
yarn install

# Build the on-chain program
anchor build

# Run tests (builds, deploys to localnet, runs Mocha suite)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

### Prerequisites

- Rust 1.94.1+ with the Solana BPF toolchain
- Solana CLI 3.1.12+ (Agave)
- Anchor CLI 0.31.1
- Node.js 22+
- Yarn

## Documentation

- **Full specification:** [`liquidity_hedge_protocol_poc(1).md`](liquidity_hedge_protocol_poc(1).md)
- **Academic paper:** [`DLT2026_Paper_A-6.pdf`](DLT2026_Paper_A-6.pdf)
- **Contribution guidelines:** [`contribution_guide.md`](contribution_guide.md)

## License

ISC
