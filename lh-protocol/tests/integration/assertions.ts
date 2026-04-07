/**
 * Correctness assertions for the integration test.
 * Each returns a pass/fail result with details.
 */

import { AssertionResult, SimulatedPayout } from "./types";
import { PoolState, CertStatus } from "../../protocol/types";

function check(
  name: string,
  condition: boolean,
  expected: string,
  actual: string,
): AssertionResult {
  return {
    name,
    passed: condition,
    expected,
    actual,
    message: condition ? "OK" : `FAIL: expected ${expected}, got ${actual}`,
  };
}

export function runAssertions(data: {
  poolBefore: PoolState;
  poolAfter: PoolState;
  rtDeposit: number;
  premiumUsdc: number;
  payoutUsdc: number;
  rtShares: number;
  rtReturned: number;
  certState: number;
  positionProtectedByCleared: boolean;
  positionReleased: boolean;
  entryPriceE6: number;
  conservativePriceE6: number;
  simulatedPayouts: SimulatedPayout[];
  capUsdc: number;
}): AssertionResult[] {
  const results: AssertionResult[] = [];

  // 1. Pool reserves = deposit + premium - payout
  const expectedReserves = data.rtDeposit + data.premiumUsdc - data.payoutUsdc;
  results.push(check(
    "Pool reserves accounting",
    Math.abs(data.poolAfter.reservesUsdc - expectedReserves) <= 1,
    String(expectedReserves),
    String(data.poolAfter.reservesUsdc),
  ));

  // 2. RT returned USDC = shares * NAV
  if (data.poolAfter.totalShares > 0 && data.rtShares > 0) {
    const expectedReturn = Math.floor(
      (data.rtShares * data.poolAfter.reservesUsdc) / data.poolAfter.totalShares
    );
    results.push(check(
      "RT share redemption matches NAV",
      Math.abs(data.rtReturned - expectedReturn) <= 1,
      String(expectedReturn),
      String(data.rtReturned),
    ));
  }

  // 3. Payout = 0 when conservative price >= entry
  if (data.conservativePriceE6 >= data.entryPriceE6) {
    results.push(check(
      "No payout when conservative price >= entry",
      data.payoutUsdc === 0,
      "0",
      String(data.payoutUsdc),
    ));
  } else if (data.payoutUsdc > 0) {
    results.push(check(
      "Payout triggered because conservative price < entry",
      data.conservativePriceE6 < data.entryPriceE6,
      `< ${data.entryPriceE6}`,
      String(data.conservativePriceE6),
    ));
  }

  // 4. Payout <= cap
  results.push(check(
    "Payout does not exceed cap",
    data.payoutUsdc <= data.capUsdc,
    `<= ${data.capUsdc}`,
    String(data.payoutUsdc),
  ));

  // 5. Certificate state machine
  results.push(check(
    "Certificate final state is SETTLED or EXPIRED",
    data.certState === CertStatus.SETTLED || data.certState === CertStatus.EXPIRED,
    "SETTLED(2) or EXPIRED(3)",
    String(data.certState),
  ));

  // 6. If payout > 0, cert should be SETTLED
  if (data.payoutUsdc > 0) {
    results.push(check(
      "Payout > 0 implies SETTLED state",
      data.certState === CertStatus.SETTLED,
      String(CertStatus.SETTLED),
      String(data.certState),
    ));
  }

  // 7. Position protection cleared after settlement
  results.push(check(
    "Position protectedBy cleared after settlement",
    data.positionProtectedByCleared,
    "null",
    data.positionProtectedByCleared ? "null" : "still set",
  ));

  // 8. Position released
  results.push(check(
    "Position status is RELEASED",
    data.positionReleased,
    "RELEASED",
    data.positionReleased ? "RELEASED" : "not released",
  ));

  // 9. Active cap released
  results.push(check(
    "Active cap is 0 after settlement",
    data.poolAfter.activeCapUsdc === 0,
    "0",
    String(data.poolAfter.activeCapUsdc),
  ));

  // 10. Simulated payouts are monotonically non-decreasing as price drops (within corridor)
  const corridorPayouts = data.simulatedPayouts
    .filter((p) => p.changePct <= 0 && !p.barrierBreached)
    .sort((a, b) => b.changePct - a.changePct); // highest to lowest price

  let monotonic = true;
  for (let i = 1; i < corridorPayouts.length; i++) {
    if (corridorPayouts[i].payoutUsdc < corridorPayouts[i - 1].payoutUsdc) {
      monotonic = false;
      break;
    }
  }
  results.push(check(
    "Simulated payouts increase as price drops within corridor",
    monotonic,
    "monotonically non-decreasing",
    monotonic ? "monotonically non-decreasing" : "non-monotonic",
  ));

  return results;
}

// ─── v2 Assertions ──────────────────────────────────────────────────

export function runV2Assertions(data: {
  premiumTotal: number;
  premiumUpfront: number;
  premiumDeferred: number;
  deferredPremiumReleased: number;
  rtTickLower: number;
  rtTickUpper: number;
  lpTickLower: number;
  lpTickUpper: number;
  rtReturnedUsdc: number;
  rtDepositedUsdc: number;
  rtDeferredEarned: number;
  feeShareBps: number;
  feeShareMinBps: number;
  feeShareMaxBps: number;
  poolReservesAfterSettle: number;
  rtDeposit: number;
  upfrontPremium: number;
  payout: number;
  deferredReleased: number;
}): AssertionResult[] {
  const results: AssertionResult[] = [];

  // 1. Premium split: upfront + deferred == total
  results.push(check(
    "Premium split: upfront + deferred == total",
    data.premiumUpfront + data.premiumDeferred === data.premiumTotal,
    String(data.premiumTotal),
    String(data.premiumUpfront + data.premiumDeferred),
  ));

  // 2. Deferred premium released at settlement equals deferred amount
  if (data.premiumDeferred > 0) {
    results.push(check(
      "Deferred premium fully released at settlement",
      data.deferredPremiumReleased === data.premiumDeferred,
      String(data.premiumDeferred),
      String(data.deferredPremiumReleased),
    ));
  }

  // 3. RT position tick range wider than LP
  const rtWidth = data.rtTickUpper - data.rtTickLower;
  const lpWidth = data.lpTickUpper - data.lpTickLower;
  results.push(check(
    "RT tick range wider than LP",
    rtWidth >= lpWidth,
    `>= ${lpWidth}`,
    String(rtWidth),
  ));

  // 4. Fee share within configured range
  if (data.feeShareMaxBps > 0) {
    results.push(check(
      "Fee share within [min, max] range",
      data.feeShareBps >= data.feeShareMinBps && data.feeShareBps <= data.feeShareMaxBps,
      `[${data.feeShareMinBps}, ${data.feeShareMaxBps}]`,
      String(data.feeShareBps),
    ));
  }

  // 5. Pool reserves after settlement: rtDeposit + upfrontPremium + deferredReleased - payout
  const expectedReserves = data.rtDeposit + data.upfrontPremium + data.deferredReleased - data.payout;
  results.push(check(
    "Pool reserves after settlement (v2 accounting)",
    Math.abs(data.poolReservesAfterSettle - expectedReserves) <= 1,
    String(expectedReserves),
    String(data.poolReservesAfterSettle),
  ));

  // 6. RT gets back at least their deposit + deferred premium (at expiry, no penalty)
  if (data.rtDeferredEarned > 0) {
    results.push(check(
      "RT returned includes deferred premium",
      data.rtReturnedUsdc >= data.rtDepositedUsdc + data.rtDeferredEarned - 1,
      `>= ${data.rtDepositedUsdc + data.rtDeferredEarned}`,
      String(data.rtReturnedUsdc),
    ));
  }

  return results;
}

