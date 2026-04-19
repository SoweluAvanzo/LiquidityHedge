# Liquidity Hedge Protocol — Final Version

Off-chain emulator and comprehensive test suite for the corridor hedge certificate protocol. Designed to accompany a scientific paper on impermanent loss hedging for concentrated liquidity positions.

## Protocol Summary

A corridor certificate hedges the impermanent loss of a concentrated liquidity (CL) position on Orca Whirlpools (SOL/USDC). The payoff exactly replicates the LP's loss within the position range, eliminating basis risk.

**Canonical premium formula:**

```
Premium = max(P_floor, FV · m_vol − y · E[F])
```

| Symbol | Meaning |
|--------|---------|
| `P_floor` | Governance-set minimum premium (RT participation constraint) |
| `FV` | Fair value: risk-neutral expected corridor payoff (numerical integration under GBM) |
| `m_vol` | Volatility markup: `max(markupFloor, IV/RV)` |
| `y` | Fee-split rate: share of LP trading fees transferred to RT at settlement |
| `E[F]` | Expected LP trading fees over the tenor |

**Key design choices:**
- Barrier = lower bound of CL position range (no separate parameter)
- Full corridor coverage (no cover ratio)
- Single product: ±10% width, 7-day tenor

## Quick Start

```bash
yarn install
yarn test          # Run all 133 tests
yarn live-test     # Run 52-week simulation
```

## Test Suite (133 tests)

| Category | Tests | Purpose |
|----------|-------|---------|
| Unit: math | 22 | CL value function, sqrt conversions, corridor payoff |
| Unit: pricing | 20 | Canonical formula, heuristic proxy, GH quadrature, monotonicity |
| Unit: pool | 16 | NAV shares, deposit/withdraw, utilization guard |
| Unit: certificates | 18 | Buy/settle lifecycle, state transitions |
| Unit: regime | 12 | Severity calibration, IV/RV, feedback correction |
| Integration | 15 | Full lifecycle, multi-certificate, edge cases |
| Scenarios | 11 | Hedge effectiveness, RT viability, fee-split analysis |
| Invariants | 8 | Economic guarantees under random inputs |

## Directory Structure

```
protocol-src/           Off-chain emulator
  index.ts              OffchainLhProtocol class (implements ILhProtocol)
  interface.ts          ILhProtocol interface
  types.ts              Constants, state interfaces
  config/templates.ts   Product template, pool defaults
  operations/
    pricing.ts          Premium formula + heuristic FV + numerical quadrature
    pool.ts             NAV deposit/withdraw, utilization
    certificates.ts     Buy + settle lifecycle
    regime.ts           Regime snapshot, severity calibration, IV/RV
  utils/
    math.ts             Integer sqrt, tick/price conversions
    position-value.ts   CL value function V(S), natural cap, corridor payoff
  state/store.ts        In-memory state store
  audit/logger.ts       Structured audit log

tests/                  Comprehensive test suite
  helpers.ts            Factory functions, GBM simulation, RNG

docs/                   Scientific documentation (7 files)
  01_introduction.md    Problem statement, protocol overview
  02_mathematical_foundations.md   CL mechanics, GBM, corridor payoff proofs
  03_pricing_methodology.md       FV computation, premium formula derivation
  04_protocol_mechanism.md        Pool, certificates, fee split
  05_risk_parameters.md           Vol estimation, IV/RV, severity calibration
  06_implementation.md            Architecture, state machines, integer math
  07_references.md                27 scientific references

scripts/
  live-scenario-test.ts   52-week GBM simulation with markdown report
```

## Documentation

The `docs/` directory contains the scientific foundation for the protocol. Each document is self-contained with formal definitions, proofs, worked examples, and references. See `docs/07_references.md` for the full bibliography.
