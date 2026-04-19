# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Liquidity Hedge Protocol — a corridor hedge certificate for concentrated liquidity positions on Orca Whirlpools (SOL/USDC). The LP buys a certificate whose payoff exactly replicates impermanent loss within the position's price range, transferring bounded downside risk to a Risk Taker (RT) who underwrites a USDC protection pool.

The canonical premium formula is:
```
Premium = max(P_floor, FV · m_vol − y · E[F])
```

The full specification is in `liquidity_hedge_protocol_poc(1).md`. The academic paper is `DLT2026_Paper_A-6.pdf`.

## Stack

- **Off-chain emulator:** TypeScript (Node 22), `@solana/web3.js` v1.x, `@solana/spl-token` v0.4
- **Live integration:** Orca Whirlpools (raw instruction builders), Birdeye OHLCV API
- **Testing:** Mocha + Chai (133 tests)
- **Target deployment:** Anchor 0.31.1, Solana (Agave) 3.1.12

## Build & Test Commands

All commands run from `lh-protocol/` subdirectory:

```bash
yarn install                          # install dependencies
yarn test                             # run all 133 tests
yarn test:unit                        # unit tests only (pricing, pool, certificates, math, regime)
yarn test:integration                 # full lifecycle, multi-certificate, edge cases
yarn test:scenarios                   # hedge effectiveness, RT viability, fee-split analysis
yarn test:invariants                  # economic invariants under random inputs
yarn live-test                        # backtest with real Birdeye SOL/USDC prices
yarn live-orca                        # live test with real Orca position on Solana
```

## Architecture

### Off-chain emulator: `lh-protocol/protocol-src/`

- **operations/** — Core protocol logic
  - `pricing.ts` — Canonical premium formula, heuristic FV proxy, numerical quadrature
  - `pool.ts` — NAV-based USDC pool (deposit, withdraw, utilization guard)
  - `certificates.ts` — Certificate lifecycle (buy, settle)
  - `regime.ts` — Regime snapshot, severity calibration, IV/RV
- **clients/** — External integrations
  - `birdeye.ts` — Birdeye OHLCV API client, volatility computation
  - `whirlpool-ix.ts` — Raw Orca Whirlpool instruction builders
  - `config.ts` — Program IDs, mints, PDA derivation
- **utils/** — CL math (`position-value.ts`), integer sqrt (`math.ts`)
- **state/** — In-memory state store with JSON persistence
- **audit/** — Structured JSONL audit logging
- **interface.ts** — `ILhProtocol` interface
- **index.ts** — `OffchainLhProtocol` class implementing the interface
- **types.ts** — Constants (PPM, BPS, Q64), state interfaces

### Documentation: `lh-protocol/docs/`

Eight files covering mathematical foundations, pricing methodology, protocol mechanism, risk parameters, implementation details, references, and empirical results.

## Key Design Decisions

- **Barrier = lower bound of CL position range** — no separate barrier parameter; the corridor covers the full concentrated range
- **No cover ratio** — full corridor coverage always
- **P_floor is a governance parameter** — not derived from a formula
- **m_vol = max(markupFloor, IV/RV)** — variance risk premium from option markets
- **Fee split** — RT receives y% of LP trading fees at settlement (premium discount at purchase)
- **Value-neutrality theorem** — LP_PnL + RT_PnL = Unhedged_PnL − protocolFee (Theorem 2.2)

## Premium Formula

```
Premium = max(P_floor, FV · m_vol − y · E[F])
```

- `FV` = fair value via numerical integration under risk-neutral GBM
- `m_vol` = `max(markupFloor, IV/RV)`
- `y` = fee-split rate (e.g. 10%)
- `E[F]` = expected LP trading fees over tenor
- `P_floor` = governance minimum (e.g. 1% of position value)

## Corridor Payoff

```
Π(S_T) = min(Cap, max(0, V(S_0) − V(max(S_T, B))))
```

where V(S) is the CL position value function (3-piece piecewise), B = p_l (barrier = lower price bound), Cap = V(S_0) − V(B).

## State Machines

- `PositionState.status`: `Locked (1) → Released (2) | Closed (3)`
- `CertificateState.state`: `Created (0) → Active (1) → Settled (2) | Expired (3)`

## Constants

```typescript
PPM = 1_000_000          // parts per million
BPS = 10_000             // basis points
DEFAULT_MARKUP_FLOOR = 1.05
DEFAULT_FEE_SPLIT_RATE = 0.10
DEFAULT_PREMIUM_FLOOR_USDC = 1_500_000  // $1.50
DEFAULT_PROTOCOL_FEE_BPS = 150          // 1.5%
DEFAULT_U_MAX_BPS = 3_000              // 30%
```
