# Liquidity Hedge Protocol — Final Version

Off-chain emulator and comprehensive test suite for the Liquidity Hedge certificate protocol. Designed to accompany a scientific paper on impermanent loss hedging for concentrated liquidity positions.

## Protocol Summary

A **Liquidity Hedge certificate** is a signed swap on the CL value function `V(·)`. Inside the active range `[p_l, p_u]` the payoff exactly replicates the LP's mark-to-market change (downside → RT pays LP; upside → LP pays RT out of position proceeds), locking the LP at `V(S_0)` minus premium. Outside the range the payoff saturates at `+Cap_down` (below `p_l`) or `−Cap_up` (above `p_u`).

**Payoff:**

```
Π(S_T) = V(S_0) − V(clamp(S_T, p_l, p_u))   ∈ [−Cap_up, +Cap_down]
```

**Canonical premium formula:**

```
Premium = max(P_floor, FV · m_vol − y · E[F])
```

| Symbol | Meaning |
|--------|---------|
| `P_floor` | Governance-set minimum premium (RT participation constraint) |
| `FV` | Fair value: risk-neutral expected signed-swap payoff (numerical integration under GBM; positive by Jensen on concave `V`) |
| `m_vol` | Volatility markup: `max(markupFloor, IV/RV)` |
| `y` | Fee-split rate: share of LP trading fees transferred to RT at settlement |
| `E[F]` | Expected LP trading fees over the tenor |

**Key design choices:**
- Barrier = lower bound of CL position range (no separate parameter)
- Full coverage within `[p_l, p_u]` (no cover ratio)
- Signed bilateral settlement; LP obligations physically covered by escrowed position
- Single product: ±10% width, 7-day tenor

## Quick Start

```bash
yarn install
yarn test          # Run all 139 tests
yarn live-test     # Run 56-week Birdeye backtest
yarn sensitivity   # 360-row parameter-sensitivity sweep (validates Theorem 2.2 robustness)
yarn live-orca     # Real mainnet end-to-end (requires funded wallets + .env)
```

## Test Suite (139 tests)

| Category | Tests | Purpose |
|----------|-------|---------|
| Unit: math | 28 | CL value function, sqrt conversions, signed Liquidity Hedge payoff |
| Unit: pricing | 20 | Canonical formula, heuristic proxy, GH quadrature, monotonicity |
| Unit: pool | 16 | NAV shares, deposit/withdraw, utilization guard |
| Unit: certificates | 18 | Buy/settle lifecycle, state transitions |
| Unit: regime | 12 | Severity calibration, IV/RV, feedback correction |
| Integration | 15 | Full lifecycle, multi-certificate, edge cases |
| Scenarios | 12 | Hedge effectiveness (incl. upside give-up), RT viability, fee-split analysis |
| Invariants | 8 | Economic guarantees under random inputs (`−Cap_up ≤ Π ≤ Cap_down`) |

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
    position-value.ts   CL value function V(S), natural caps (up/down), signed Liquidity Hedge payoff
  state/store.ts        In-memory state store
  audit/logger.ts       Structured audit log

tests/                  Comprehensive test suite
  helpers.ts            Factory functions, GBM simulation, RNG

docs/                   Scientific documentation (7 files)
  01_introduction.md    Problem statement, protocol overview
  02_mathematical_foundations.md   CL mechanics, GBM, Liquidity Hedge payoff proofs, value-neutrality theorem
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
