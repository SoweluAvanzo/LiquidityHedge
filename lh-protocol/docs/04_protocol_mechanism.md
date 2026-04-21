# 4. Protocol Mechanism

## 4.1 NAV-Based Protection Pool

### 4.1.1 Pool Design

The protection pool holds USDC reserves deposited by Risk Takers (RTs). Share tokens track each RT's pro-rata ownership of the reserves. The pool design follows a Net Asset Value (NAV) model analogous to mutual fund share pricing.

**State variables:**

| Field | Type | Description |
|-------|------|-------------|
| `reservesUsdc` | integer | Total USDC in the vault (micro-USDC) |
| `totalShares` | integer | Total outstanding share tokens |
| `activeCapUsdc` | integer | Sum of caps across all active certificates |
| `uMaxBps` | integer | Maximum utilization ratio (BPS, default: 3000 = 30%) |
| `markupFloor` | float | Minimum volatility markup (default: 1.05) |
| `feeSplitRate` | float | Fraction of LP fees transferred to RT (default: 0.10) |
| `expectedDailyFee` | float | Expected daily LP fee rate (default: 0.005) |
| `premiumFloorUsdc` | integer | Governance minimum premium (micro-USDC) |
| `protocolFeeBps` | integer | Treasury fee on premiums (BPS, default: 150 = 1.5%) |

### 4.1.2 Share Pricing

The share price `P_share` reflects the pool's NAV per share:

```
P_share = reservesUsdc / totalShares
```

For an empty pool (`totalShares = 0`), `P_share = 1.000000` (i.e., 1 share = 1 micro-USDC).

**Value accretion.** When premiums are collected, `reservesUsdc` increases without minting new shares, so `P_share` rises. When payouts are disbursed, `reservesUsdc` decreases, so `P_share` falls. This mechanism ensures:

- Earlier depositors benefit from premiums collected after their deposit.
- Payouts are socialized across all RTs in proportion to their share holdings.

### 4.1.3 Deposit Formula

When an RT deposits `amount` micro-USDC:

```
shares = floor(amount * totalShares / reservesUsdc),   if totalShares > 0
shares = amount,                                        if totalShares = 0 (first deposit)
```

The first deposit establishes the 1:1 baseline. Subsequent deposits receive shares at the current NAV, meaning:

```
value_of_new_shares = shares * P_share_after 
                    = floor(amount * totalShares / reservesUsdc) * ((reservesUsdc + amount) / (totalShares + shares))
```

This is approximately equal to `amount`, with rounding error of at most 1 micro-USDC.

### 4.1.4 Withdrawal Formula

When an RT withdraws by burning `sharesToBurn` shares:

```
usdcReturned = floor(sharesToBurn * reservesUsdc / totalShares)
```

The withdrawal is subject to the **utilization guard**.

### 4.1.5 Utilization Guard

The utilization guard prevents withdrawals that would leave the pool unable to cover outstanding liabilities:

```
postReserves = reservesUsdc - usdcReturned
minReserves = ceil(activeCapUsdc * BPS / uMaxBps)

Requirement: postReserves >= minReserves
```

With `uMaxBps = 3000` (30%), this means the pool must retain at least `activeCapUsdc / 0.30` in reserves after any withdrawal. This ensures the pool can cover the worst-case scenario where all active certificates pay out at their full cap.

**Example.** If `activeCapUsdc = $30` and `uMaxBps = 3000`:

```
minReserves = ceil(30_000_000 * 10_000 / 3_000) = 100_000_000 ($100)
```

The pool must maintain at least \$100 in reserves while \$30 of certificates are active.

## 4.2 Certificate Lifecycle

### 4.2.1 State Machine

The certificate lifecycle follows a deterministic state machine:

```
                   buyCertificate
                        |
                        v
                   +---------+
                   | ACTIVE  |
                   |  (1)    |
                   +---------+
                        |
                   settleCertificate
                   (at/after expiry)
                        |
                   +----+----+
                   |         |
                   v         v
             +---------+ +---------+
             | SETTLED | | EXPIRED |
             |   (2)   | |   (3)   |
             +---------+ +---------+
```

- **ACTIVE (1)**: Protection is in force. The position NFT is locked, the pool's `activeCapUsdc` includes this certificate's `Cap_down` reservation.
- **SETTLED (2)**: Any non-zero signed swap payoff at expiry.
  - `S_T < S_0` ⇒ `Π > 0` ⇒ RT pays LP (up to `+Cap_down`).
  - `S_T > S_0` ⇒ `Π < 0` ⇒ LP pays RT from escrowed position proceeds (up to `−Cap_up`).
- **EXPIRED (3)**: The measure-zero event `S_T = S_0` exactly, where `Π = 0`. In practice virtually all settlements under GBM reach `SETTLED`.

### 4.2.2 Buy Flow

The `buyCertificate` operation proceeds as follows:

```
1. VALIDATE position:
   - Position must exist and be LOCKED
   - Position must not already be protected (protectedBy == null)

2. VALIDATE regime:
   - Regime snapshot must exist
   - Regime must be fresh: now - updatedAt <= REGIME_MAX_AGE_S (900s)

3. DERIVE barrier and bounds:
   barrier = S_0 * (1 - widthBps / BPS)
   p_u = S_0 * (1 + widthBps / BPS)

4. COMPUTE natural cap:
   Cap = V(S_0) - V(barrier)

5. CHECK utilization headroom:
   availableHeadroom = floor(reservesUsdc * uMaxBps / BPS) - activeCapUsdc
   Require: Cap <= availableHeadroom

6. COMPUTE premium via canonical formula:
   FV = heuristicFV(cap, template, pool, regime)
   feeDiscount = y * notional * dailyFee * tenorDays
   Premium = max(P_floor, FV * m_vol - feeDiscount)

7. DEDUCT protocol fee:
   protocolFee = floor(Premium * protocolFeeBps / BPS)
   premiumToPool = Premium - protocolFee

8. UPDATE state:
   pool.reservesUsdc += premiumToPool
   pool.activeCapUsdc += Cap
   position.protectedBy = certificateId
   Create certificate record with state = ACTIVE
```

### 4.2.3 Settlement Flow

The `settleCertificate` operation is **permissionless** -- any account can trigger it for protocol liveness:

```
1. VALIDATE certificate:
   - Certificate must exist and be ACTIVE
   - Current time must be >= expiryTs

2. COMPUTE signed Liquidity Hedge payoff:
   clamped_price = clamp(S_T, p_l, p_u)
   payout_signed = V(S_0) − V(clamped_price)        // ∈ [−Cap_up, +Cap_down]

3. COMPUTE fee split:
   rtFeeIncome = floor(feeSplitRate * feesAccruedUsdc)

4. DETERMINE final state:
   if payout_signed != 0: state = SETTLED           // almost always true
   else:                  state = EXPIRED           // measure-zero: S_T = S_0

5. UPDATE state:
   certificate.state = finalState
   certificate.settlementPriceE6 = S_T
   certificate.payoutUsdc = payout_signed           // signed
   certificate.rtFeeIncomeUsdc = rtFeeIncome
   pool.reservesUsdc -= payout_signed               // negative payout ⇒ reserves grow
   pool.reservesUsdc += rtFeeIncome
   pool.activeCapUsdc -= Cap_down                   // releases the downside reservation
   position.protectedBy = null

   When payout_signed < 0 the LP owes the pool; the obligation is
   covered physically from the escrowed position's proceeds (the CL
   geometry guarantees V(S_T) >= V(S_0) + |payout_signed| whenever
   S_T > S_0, so no external LP collateral is needed).
```

## 4.3 Position Escrow

### 4.3.1 NFT Custody

The LP's Orca Whirlpool position is represented by an NFT. To purchase a Liquidity Hedge certificate, the LP must first escrow this NFT in the protocol:

1. **Register**: The LP calls `registerLockedPosition`, transferring the position NFT to the protocol's escrow vault. The position enters `LOCKED` status.
2. **Protection**: The position's `protectedBy` field is set when a certificate is purchased, preventing release during the protection period.
3. **Release**: After the certificate is settled or expired, `protectedBy` is cleared and the LP can call `releasePosition` to recover the NFT. The position enters `RELEASED` status.

### 4.3.2 Position State Machine

```
registerLockedPosition         releasePosition
        |                            |
        v                            v
   +--------+                  +----------+
   | LOCKED |  ────────────>   | RELEASED |
   |  (1)   |  (cert settled)  |   (2)    |
   +--------+                  +----------+
```

**Invariant**: A position with `protectedBy != null` cannot be released. This prevents the LP from withdrawing the position while the RT is exposed to the Liquidity Hedge payoff (and while the position is the collateral backing any potential LP→RT give-up).

## 4.4 Fee Split Mechanism

### 4.4.1 Design Rationale

The fee split aligns incentives between LP and RT:

- **LP perspective**: The fee discount `y * E[F]` reduces the upfront premium, making the hedge cheaper. The LP keeps `(1 - y) * F` of their trading fees.
- **RT perspective**: At settlement, the RT pool receives `y * feesAccrued` on top of the signed swap PnL, providing a third income stream (alongside the premium and the LP's upside give-up when `S_T > S_0`). This makes the RT's total return a blend of variance-risk premium, convexity wedge, and fee sharing — not pure insurance writing.

### 4.4.2 Timing

The fee split operates at two points:

1. **At purchase (premium discount)**: The expected fee income `y * E[F]` is subtracted from the premium. This is an estimate based on `expectedDailyFee * tenorDays * notional`.

2. **At settlement (actual transfer)**: The actual accrued fees `feesAccruedUsdc` are read from the position, and `y * feesAccruedUsdc` is transferred to the pool. If actual fees exceed the estimate, the RT benefits; if they fall short, the RT is partially compensated by the premium.

### 4.4.3 Net RT Position per Certificate

The RT's net profit/loss on a single certificate is:

```
RT_PnL = premiumToPool − PI(S_T) + rtFeeIncome
       = (Premium − protocolFee) − PI(S_T) + y · feesAccrued
```

Under the signed swap `PI(S_T)` is negative when `S_T > S_0`, so the RT *gains* from the LP's upside give-up in addition to collecting the premium. The RT is profitable whenever `premiumToPool + rtFeeIncome − PI(S_T) > 0`; by Theorem 2.2 this holds *on average* whenever the premium is priced at or above the risk-neutral FV of the swap.

## 4.5 Protocol Fee

A fraction of each premium is directed to the protocol treasury:

```
protocolFee = floor(Premium * protocolFeeBps / BPS)
```

With the default `protocolFeeBps = 150` (1.5%), a \$1.00 premium generates \$0.015 for the treasury. The protocol fee is deducted before the premium flows to the pool, so:

```
premiumToPool = Premium - protocolFee
```

## 4.6 Worked Example: Full Lifecycle

**Setup:**
- RT deposits \$100 USDC into the pool.
- LP opens a CL position at `S_0 = $150`, range `[$135, $165]`, liquidity `L = 50`.
- LP registers the position and purchases a 7-day Liquidity Hedge certificate.
- After 7 days, `S_T = $142` and LP accrued \$0.80 in fees.

**Step 1: RT Deposit**

```
Before: reservesUsdc = 0, totalShares = 0
Deposit: amount = 100,000,000 micro-USDC
After: reservesUsdc = 100,000,000, totalShares = 100,000,000
Share price: 1.000000
```

**Step 2: Certificate Purchase**

```
Cap_down = V(150) − V(135) = 60.00 − 55.48 = \$4.52
Cap_up   = V(165) − V(150) = 61.30 − 60.00 = \$1.30
Utilization headroom: floor(100M * 3000 / 10000) − 0 = \$30.00 > \$4.52 (OK)

Premium     = \$0.389 (Liquidity Hedge swap — from Section 3.5 worked example)
Protocol fee = \$0.006
Premium to pool = \$0.383

After purchase:
  reservesUsdc = 100,383,559
  totalShares  = 100,000,000
  activeCapUsdc = 4,520,000   (reserves against Cap_down only)
  Share price: 1.003836
```

**Step 3: Settlement at S_T = \$142 (within range, below S_0)**

```
clamp(142, 135, 165) = 142
V(142) = 50 * (2·sqrt(142) − 142/sqrt(165) − sqrt(135))
       = 50 * (2·11.916 − 11.053 − 11.619)
       = 50 * 1.160 = \$58.01

payout_signed = V(150) − V(142) = 60.00 − 58.01 = +\$1.99   (RT pays LP)

Fee split: rtFeeIncome = 0.10 * 800,000 = 80,000 micro-USDC (\$0.08)

After settlement:
  reservesUsdc = 100,383,559 − 1,990,000 + 80,000 = 98,473,559
  activeCapUsdc = 0
  totalShares   = 100,000,000
  Share price: 0.984736
```

**RT P&L:**

```
premiumToPool = +\$0.383
payout_signed = −\$1.990
rtFeeIncome   = +\$0.080
Net = 0.383 − 1.990 + 0.080 = −\$1.527

Share price change: 1.003836 → 0.984736 = −1.90%
```

In this realization the RT loses on the certificate because SOL dropped 5.3% — but under the signed-swap design the RT also collects the upside give-up when `S_T > S_0`, so across many certificates with `sigma = 65%` and `width = +/-10%` the expected RT P&L converges to the variance risk premium plus the fee-split contribution (Theorem 2.2 guarantees the LP+RT sum equals the unhedged PnL minus the treasury fee).

**LP P&L:**

```
Position IL        = V(150) − V(142)    = \$1.99    (loss, signed negative in PnL)
Certificate payout = +\$1.99             (RT paid LP — exact IL replication)
Fee income retained = (1 − 0.10) * \$0.80 = \$0.72
Premium paid        = −\$0.389

Net = −1.99 + 1.99 + 0.72 − 0.389 = +\$0.331
```

The LP's IL is fully offset by the certificate payout; the LP retains 90% of fee income minus the (now smaller) premium cost. Note that under the swap the LP's premium is ~40% lower than the capped-put equivalent, because the swap's fair value is smaller (`FV_swap = FV_put − FV_call_spread`).

**Alternative Step 3: Settlement at S_T = \$158 (within range, above S_0)**

```
clamp(158, 135, 165) = 158
V(158) = 50 * (2·sqrt(158) − 158/sqrt(165) − sqrt(135))
       ≈ \$60.84

payout_signed = V(150) − V(158) = 60.00 − 60.84 = −\$0.84   (LP pays RT)

Physical settlement: the position (now worth V(158) ≈ \$60.84) yields \$0.84
to the RT pool, leaving the LP with exactly V(S_0) = \$60.00.

RT P&L on this path:
  premiumToPool  = +\$0.383
  payout_signed  = +\$0.84 (RT receives from LP)
  rtFeeIncome    = +\$0.080
  Net            = 0.383 + 0.840 + 0.080 = +\$1.303

LP P&L on this path:
  Position value at expiry = \$60.84
  Payout surrendered       = −\$0.84
  Fee income retained      = +\$0.72
  Premium paid             = −\$0.389
  Net vs. entry value      = (60.84 − 60.00) − 0.84 + 0.72 − 0.389 = +\$0.331
```

Both realizations (down and up) leave the **LP at the same locked net outcome** `V(S_0) − Premium + (1 − y)·F`, which is the defining property of the Liquidity Hedge swap.
