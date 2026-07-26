/**
 * Heuristic fair-value proxy — QUARANTINED, not part of the public API.
 *
 * This is the integer-arithmetic FV approximation retained for a future
 * on-chain Anchor program (BPF cannot afford Simpson N=200). It is NOT
 * exported from the package barrel and MUST NOT be used in any product
 * quote path: the test suite proves it systematically under-prices by
 * ~10× versus `computeQuadratureFV` (see pricing-formula-bound.test.ts).
 *
 * Off-chain quoting always uses `computeQuote` → `computeQuadratureFV_E6`.
 */

import {
  PPM_BI,
  BPS_BI,
  SECONDS_PER_YEAR,
  PoolState,
  RegimeSnapshot,
  TemplateConfig,
} from "../types";
import { integerSqrt } from "../utils/math";
import { checkUtilizationHeadroom } from "./pricing";

export interface HeuristicBreakdown {
  pHitPpm: number;
  expectedPayoutUsdc: number;
  capitalChargeUsdc: number;
  adverseSelectionUsdc: number;
  replicationCostUsdc: number;
  totalUsdc: number;
}

/**
 * Compute the heuristic fair-value proxy.
 *
 *   p_hit = min(1, 0.9 * σ * √T / width)
 *   E[Payout] = Cap * p_hit * severity / PPM²
 *   C_cap = Cap * (U_after / PPM)² / 5
 *   C_adv = Cap / 10 if stress, else 0
 *   C_rep = Cap * carry_bps * tenor_sec / BPS / (100 * 86400)
 *   FV_heuristic = clamp(E[Payout] + C_cap + C_adv + C_rep, 0, ceiling)
 *
 * Returns null if utilization would be exceeded.
 */
export function computeHeuristicFV(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot,
): HeuristicBreakdown | null {
  const util = checkUtilizationHeadroom(capUsdc, pool);
  if (!util) return null;
  const cap = BigInt(capUsdc);
  const uAfterPpm = util.uAfterPpm;

  // p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
  const sigmaPpm = BigInt(regime.sigmaPpm);
  const secondsPerYear = BigInt(SECONDS_PER_YEAR);
  const tenorPpm =
    (BigInt(template.tenorSeconds) * PPM_BI) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * PPM_BI);
  const widthPpm = BigInt(template.widthBps) * 100n;

  let pHitPpm =
    (900_000n * sigmaPpm * sqrtTPpm) /
    PPM_BI /
    (widthPpm > 0n ? widthPpm : 1n);
  if (pHitPpm > PPM_BI) pHitPpm = PPM_BI;

  // E[Payout]
  const severityPpm = BigInt(regime.severityPpm);
  const expectedPayout = (cap * pHitPpm * severityPpm) / PPM_BI / PPM_BI;

  // C_cap = Cap * (U_after / PPM)^2 / 5
  const capitalCharge =
    (cap * uAfterPpm * uAfterPpm) / PPM_BI / PPM_BI / 5n;

  // C_adv
  const adverseSelection = regime.stressFlag ? cap / 10n : 0n;

  // C_rep
  const replicationCost =
    (cap *
      BigInt(regime.carryBpsPerDay) *
      BigInt(template.tenorSeconds)) /
    BPS_BI /
    (100n * 86_400n);

  // Total (clamped to ceiling)
  let total = expectedPayout + capitalCharge + adverseSelection + replicationCost;
  const ceiling = BigInt(template.premiumCeilingUsdc);
  if (total > ceiling) total = ceiling;

  return {
    pHitPpm: Number(pHitPpm),
    expectedPayoutUsdc: Number(expectedPayout),
    capitalChargeUsdc: Number(capitalCharge),
    adverseSelectionUsdc: Number(adverseSelection),
    replicationCostUsdc: Number(replicationCost),
    totalUsdc: Number(total),
  };
}
