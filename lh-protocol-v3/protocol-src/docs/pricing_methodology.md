# Pricing Methodology -- v3

## Premium Formula

    Premium = FairValue * effectiveMarkup * coverRatio

Where:
- **FairValue**: no-arbitrage expected corridor payout computed via
  Gauss-Hermite quadrature (off-chain) or on-chain heuristic
- **effectiveMarkup**: `max(markupFloor, IV/RV)` where IV is the lower of
  Binance and Bybit ATM SOL implied vol, RV is 30-day realized vol
- **coverRatio**: LP's choice from 0.25 to 1.00

## Width and Barrier

Single product: **+/-7.5% width** (750 bps each side).

The barrier equals the lower tick of the CL position:

    barrier = S0 * (1 - 750/10000) = S0 * 0.925

## Numerical Example

Entry price S0 = $150, position width +/-7.5%:
- Upper tick: $161.25
- Lower tick (= barrier): $138.75
- Natural cap (max IL at lower tick): ~$11.25 equivalent
- At 100% cover: cap = $11.25, premium = FV * 1.25 * 1.00
- At 50% cover: cap = $5.625, premium = FV * 1.25 * 0.50

## Heuristic Subcomponents

The on-chain heuristic decomposes the fair value as:

    FV = E[Payout] + C_cap + C_adv + C_rep

- **E[Payout]** = Cap * p_hit(sigma, T, 750bps) * severity / PPM^2
- **C_cap** = Cap * (U_after / PPM)^2 / 5  (quadratic utilization charge)
- **C_adv** = Cap / 10 if stress, else 0  (adverse selection)
- **C_rep** = Cap * carry_bps * tenor / BPS / 100  (replication cost)

Where:
- p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
- width = 750 bps = 7.5%
- severity is dynamically calibrated at regime update time

## Effective Markup

    effectiveMarkup = max(1.05, IV/RV)

The 1.05 floor ensures at least a 5% markup above fair value even when
IV/RV < 1.05. In practice, SOL IV/RV typically ranges from 0.9 to 1.8,
so the floor binds only in low-vol regimes.

## Performance Fee

At settlement:

    performanceBonus = max(0, feesEarned - premiumPaid) * 0.05

If the LP's accrued fees exceed the premium paid, 5% of the excess flows
to the RT pool. This aligns incentives: when LPs earn well, RTs share
in the upside.

## Fee Share

25% of premium income accrues to the RT pool via NAV increase. This is
the RT's primary compensation for underwriting the protection.
