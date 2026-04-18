# Liquidity Hedge Protocol v3 -- Design

## Overview

v3 is a single-product protocol for cash-settled capped corridor certificates
on SOL/USDC Orca Whirlpool concentrated liquidity positions.

## Position Width

A single width is offered: **+/-7.5%** (750 bps each side of entry).

The +/-5% width was dropped because simulation showed RT is underwater at
narrow ranges. The +/-7.5% width provides the best risk-adjusted returns
for both LP and RT.

## Barrier

The barrier **always equals the lower tick** of the CL position:

    barrier = S0 * (1 - 750 / 10000) = S0 * 0.925

For a +/-7.5% position with entry at $150:
- Upper tick price: $150 * 1.075 = $161.25
- Lower tick price: $150 * 0.925 = $138.75
- Barrier: $138.75 (= lower tick)

`barrierDepthBps = 750` ensures the corridor covers the entire in-range
impermanent loss from entry to the lower tick.

## Cover Ratio

The LP chooses a cover ratio from 0.25 to 1.00 (25% to **100%** of the
natural cap). At 100% cover, the LP hedges the full corridor IL.

- Premium scales linearly: `premium = FV * markup * coverRatio`
- Payout scales linearly: `payout = fullPayout * coverRatio`
- Cap scales linearly: `cap = naturalCap * coverRatio`

## Fee Benchmarks

Expected daily fee rate for +/-7.5% SOL/USDC on Orca: **~0.55%/day**
(based on observed Whirlpool fee yields for concentrated positions at
this width).

## Premium Formula

    Premium = FairValue * max(markupFloor, IV/RV) * coverRatio

Three transparent numbers the LP sees:
1. FairValue -- no-arbitrage expected payout (GH quadrature or heuristic)
2. Effective markup -- max(1.05, IV/RV) from option markets
3. Cover ratio -- LP's choice

## Pool Economics

- RT deposits USDC into the protection pool
- 25% of premium income accrues to RT pool via NAV
- 5% performance fee on (fees - premium) excess at settlement
- 1.5% protocol fee on premium to treasury
- Max utilization: 30%

## State Machines

- PositionState.status: Locked (1) -> Released (2) | Closed (3)
- CertificateState.state: Created (0) -> Active (1) -> Settled (2) | Expired (3)
