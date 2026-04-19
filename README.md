# Liquidity Hedge Protocol

A corridor hedge certificate protocol for concentrated liquidity positions on Orca Whirlpools (SOL/USDC). The LP buys a certificate whose payoff exactly replicates the impermanent loss within the position's price range, transferring bounded downside risk to a Risk Taker (RT) who underwrites a USDC protection pool.

## How It Works

1. **LP opens** a concentrated liquidity position on Orca Whirlpools (SOL/USDC).
2. **RT deposits** USDC into the protection pool, receiving NAV-based pool shares.
3. **LP locks** the position and **buys** a corridor hedge certificate.
4. The premium is computed as: `Premium = max(P_floor, FV · m_vol − y · E[F])`.
5. On expiry, **anyone can settle** the certificate (permissionless).
6. If price dropped, the corridor payoff compensates the LP's impermanent loss, capped at the natural cap.
7. The RT receives the premium plus a share of LP trading fees.

### Corridor Payoff

```
Π(S_T) = min(Cap, max(0, V(S_0) − V(max(S_T, B))))
```

where `V(S)` is the concentrated liquidity position value function, `B` is the barrier (= lower bound of the position range), and `Cap = V(S_0) − V(B)` is the natural cap.

### Premium Formula

```
Premium = max(P_floor, FV · m_vol − y · E[F])
```

| Term | Meaning |
|------|---------|
| `P_floor` | Governance-set minimum premium |
| `FV` | Fair value: risk-neutral expected payoff under GBM |
| `m_vol` | Volatility markup: `max(markupFloor, IV/RV)` |
| `y · E[F]` | Fee discount: fee-split rate × expected LP fees |

### Key Result (Theorem 2.2)

The corridor hedge is a **value-neutral redistribution**: `LP_PnL + RT_PnL = Unhedged_PnL − protocolFee`. The two-sided breakeven yield equals the unhedged breakeven yield plus a negligible protocol fee wedge (~0.3 bps/day). At any fee yield where unhedged LPing is profitable, the protocol can be parameterized so both LP and RT are also profitable.

## Repository Structure

```
LiquidityHedge/
├── lh-protocol/                       # Protocol implementation
│   ├── protocol-src/                  #   Off-chain emulator (TypeScript)
│   │   ├── operations/                #     pricing, pool, certificates, regime
│   │   ├── clients/                   #     Birdeye API, Orca Whirlpool instructions
│   │   ├── utils/                     #     CL math, position valuation
│   │   ├── state/                     #     In-memory state store
│   │   └── audit/                     #     Structured audit logging
│   ├── tests/                         #   133 tests (unit, integration, scenarios, invariants)
│   ├── scripts/                       #   Backtest (Birdeye data) + live Orca test
│   └── docs/                          #   8 scientific documentation files
├── DLT2026_Paper_A-6.pdf             # Academic paper
├── liquidity_hedge_protocol_poc(1).md # Original specification
└── CLAUDE.md                          # AI assistant context
```

## Quick Start

```bash
cd lh-protocol
yarn install

# Run all 133 tests
yarn test

# Backtest with real Birdeye SOL/USDC prices (requires BIRDEYE_API_KEY)
cp .env.example .env   # fill in API keys
yarn live-test

# Live test with real Orca position (requires funded wallets)
yarn live-orca
```

## Empirical Results (56 weeks of real SOL/USDC data)

| Width | Volatility Reduction | Max Drawdown Reduction | Two-Sided Breakeven | Hedge Cost |
|-------|---------------------|------------------------|--------------------|--------------------|
| ±5% | 27% | 23% | 0.416%/day | 0.1 bps/day |
| ±7.5% | 41% | 55% | 0.363%/day | 0.3 bps/day |
| ±10% | **55%** | **79%** | **0.318%/day** | **0.3 bps/day** |

## Documentation

- **Protocol docs:** [`lh-protocol/docs/`](lh-protocol/docs/) — 8 files covering mathematical foundations, pricing methodology, protocol mechanism, risk parameters, implementation, and empirical results
- **Original specification:** [`liquidity_hedge_protocol_poc(1).md`](liquidity_hedge_protocol_poc(1).md)
- **Academic paper:** [`DLT2026_Paper_A-6.pdf`](DLT2026_Paper_A-6.pdf)

## License

ISC
