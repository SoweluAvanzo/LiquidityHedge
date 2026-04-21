# Liquidity Hedge Protocol

A Liquidity Hedge certificate protocol for concentrated liquidity positions on Orca Whirlpools (SOL/USDC). The LP buys a bilateral certificate whose signed swap payoff exactly replicates the position's mark-to-market difference within the active range `[p_l, p_u]`, transferring that variability to a Risk Taker (RT) who underwrites a USDC protection pool.

## How It Works

1. **LP opens** a concentrated liquidity position on Orca Whirlpools (SOL/USDC).
2. **RT deposits** USDC into the protection pool, receiving NAV-based pool shares.
3. **LP locks** the position and **buys** a Liquidity Hedge certificate.
4. The premium is computed as: `Premium = max(P_floor, FV · m_vol − y · E[F])`.
5. On expiry, **anyone can settle** the certificate (permissionless).
6. The signed swap payoff is disbursed: if price dropped, the pool pays the LP (capped at `Cap_down`); if price rose, the LP surrenders the upside to the pool (capped at `Cap_up`, settled physically from the escrowed position's proceeds).
7. The RT receives the premium plus a share of LP trading fees.

### Liquidity Hedge Payoff (signed swap on V(·))

```
Π(S_T) = V(S_0) − V(clamp(S_T, p_l, p_u))
```

where `V(S)` is the concentrated liquidity position value function and `clamp(x, a, b) = min(max(x, a), b)`. The payoff is bounded in `[−Cap_up, +Cap_down]` where `Cap_down = V(S_0) − V(p_l)` and `Cap_up = V(p_u) − V(S_0)`. By concavity of `V`, `Cap_up < Cap_down` — the convexity wedge that makes `FV > 0`.

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

The Liquidity Hedge is a **value-neutral redistribution**: `LP_PnL + RT_PnL = Unhedged_PnL − protocolFee`. The proof depends only on the additive structure of the cash flows, not on the sign or shape of `Π`, so it holds verbatim for the signed swap. The two-sided breakeven yield equals the unhedged breakeven yield plus a negligible protocol fee wedge (0.0–0.2 bps/day under the swap). At any fee yield where unhedged LPing is profitable, the protocol can be parameterized so both LP and RT are also profitable.

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
│   ├── tests/                         #   139 tests (unit, integration, scenarios, invariants)
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

# Run all 139 tests
yarn test

# Backtest with real Birdeye SOL/USDC prices (requires BIRDEYE_API_KEY)
cp .env.example .env   # fill in API keys
yarn live-test

# Live test with real Orca position (requires funded wallets)
yarn live-orca
```

## Empirical Results (56 weeks of real SOL/USDC data, signed-swap payoff)

| Width | Volatility Reduction (medium) | Max Drawdown Reduction (medium) | Two-Sided Breakeven | Hedge Cost |
|-------|-------------------------------|---------------------------------|--------------------|--------------------|
| ±5% | 30% | −4% ¹ | 0.486%/day | 0.0 bps/day |
| ±7.5% | 43% | 28% | 0.426%/day | 0.1 bps/day |
| ±10% | **55%** | **55%** | **0.373%/day** | **0.2 bps/day** |

¹ *At narrow width the swap's symmetric upside give-up can increase drawdown in up-trending windows — this sample (2025-03 → 2026-04) was mildly up-biased. The hedge's benefit is concentrated at ±10%, where it beats unhedged by +\$2,692 to +\$4,280 over 56 weeks across all fee tiers (see `lh-protocol/docs/08_empirical_results.md` §8.3.3).*

## Documentation

- **Protocol docs:** [`lh-protocol/docs/`](lh-protocol/docs/) — 8 files covering mathematical foundations, pricing methodology, protocol mechanism, risk parameters, implementation, and empirical results
- **Original specification:** [`liquidity_hedge_protocol_poc(1).md`](liquidity_hedge_protocol_poc(1).md)
- **Academic paper:** [`DLT2026_Paper_A-6.pdf`](DLT2026_Paper_A-6.pdf)

## License

ISC
