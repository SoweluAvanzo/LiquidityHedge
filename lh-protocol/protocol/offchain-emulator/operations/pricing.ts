/**
 * Pricing operations: quote computation, template management, regime updates.
 *
 * computeQuote is an EXACT port of programs/lh-core/src/pricing/instructions.rs
 * lines 149-239. Same integer math, same constants, same formula.
 */

import {
  PoolState,
  RegimeSnapshot,
  TemplateConfig,
  QuoteBreakdown,
  PPM,
  BPS,
} from "../../types";

// ─── Integer Square Root (from math.rs) ──────────────────────────────

/** Newton's method integer sqrt — identical to programs/lh-core/src/math.rs */
export function integerSqrt(n: bigint): bigint {
  if (n === BigInt(0)) return BigInt(0);
  let x = n;
  let y = (x + BigInt(1)) / BigInt(2);
  while (y < x) {
    x = y;
    y = (x + n / x) / BigInt(2);
  }
  return x;
}

// ─── Quote Computation ───────────────────────────────────────────────

/**
 * Compute premium quote — exact port of pricing/instructions.rs:compute_quote.
 *
 * Formula:
 *   Premium = clamp(E[Payout] + C_cap + C_adv + C_rep, floor, ceiling)
 * Where:
 *   E[Payout] = Cap * p_hit(sigma, T, width) * severity / PPM^2
 *   C_cap     = Cap * (U_after / PPM)^2 / 5
 *   C_adv     = Cap / 10 if stress, else 0
 *   C_rep     = Cap * carry_bps * tenor_seconds / BPS / (100 * 86400)
 */
export function computeQuote(
  capUsdc: number,
  template: TemplateConfig,
  pool: PoolState,
  regime: RegimeSnapshot
): QuoteBreakdown {
  const ppm = BigInt(PPM);
  const bps = BigInt(BPS);
  const reserves = BigInt(Math.max(pool.reservesUsdc, 1));
  const active = BigInt(pool.activeCapUsdc);
  const cap = BigInt(capUsdc);

  // Utilization after this certificate
  const uAfterPpm = ((active + cap) * ppm) / reserves;
  const uMaxPpm = BigInt(pool.uMaxBps) * BigInt(100);

  if (uAfterPpm > uMaxPpm) {
    throw new Error(
      `InsufficientHeadroom: utilization ${uAfterPpm} > max ${uMaxPpm}`
    );
  }

  // p_hit = min(1, 0.9 * sigma * sqrt(T) / width)
  const sigmaPpm = BigInt(regime.sigmaPpm);
  const secondsPerYear = BigInt(365) * BigInt(86_400);
  const tenorPpm = (BigInt(template.tenorSeconds) * ppm) / secondsPerYear;
  const sqrtTPpm = integerSqrt(tenorPpm * ppm);
  const widthPpm = BigInt(template.widthBps) * BigInt(100);

  let pHitPpm =
    (BigInt(900_000) * sigmaPpm * sqrtTPpm) /
    ppm /
    (widthPpm > BigInt(0) ? widthPpm : BigInt(1));
  if (pHitPpm > ppm) pHitPpm = ppm;

  const severityPpm = BigInt(template.severityPpm);

  // E[Payout]
  const expectedPayout = (cap * pHitPpm * severityPpm) / ppm / ppm;

  // C_cap (quadratic utilization charge)
  const capitalCharge = (cap * uAfterPpm * uAfterPpm) / ppm / ppm / BigInt(5);

  // C_adv (adverse selection)
  const adverse = regime.stressFlag ? cap / BigInt(10) : BigInt(0);

  // C_rep (replication cost) — prorated to seconds
  const replication =
    (cap * BigInt(regime.carryBpsPerDay) * BigInt(template.tenorSeconds)) /
    bps /
    (BigInt(100) * BigInt(86_400));

  let premium = expectedPayout + capitalCharge + adverse + replication;

  // Clamp to [floor, ceiling]
  const floor = BigInt(template.premiumFloorUsdc);
  const ceiling = BigInt(template.premiumCeilingUsdc);
  if (premium < floor) premium = floor;
  if (premium > ceiling) premium = ceiling;

  return {
    premiumUsdc: Number(premium),
    capUsdc,
    expectedPayoutUsdc: Number(expectedPayout),
    capitalChargeUsdc: Number(capitalCharge),
    adverseSelectionUsdc: Number(adverse),
    replicationCostUsdc: Number(replication),
  };
}
