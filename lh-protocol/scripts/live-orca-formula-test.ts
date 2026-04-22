#!/usr/bin/env ts-node
/**
 * live-orca-formula-test.ts — run live-orca-test.ts with params tuned
 * to force the premium into formula-bound mode (FV·m_vol − y·E[F]
 * rather than P_floor). Useful for validating the pricing engine's
 * numerical behaviour on a real on-chain settlement.
 *
 * Chosen constants (see previous sensitivity analysis):
 *   TENOR_SECONDS    = 1800     (30 minutes)
 *   P_FLOOR_FRACTION = 0.000005 (0.0005% of V(S_0) ≈ $0.00001)
 *
 * These values sit in the narrow window where FV·m_vol (~$0.000023 on
 * a ~$1.82 position at σ≈0.70) comfortably beats the floor (~$0.00001),
 * so the printed premium reflects the pricing formula rather than the
 * governance floor.
 *
 * Pre-set env vars win over dotenv (.env override defaults to false),
 * so .env's TENOR_SECONDS=600 will NOT override these.
 */
process.env.TENOR_SECONDS = process.env.TENOR_SECONDS ?? "1800";
process.env.P_FLOOR_FRACTION = process.env.P_FLOOR_FRACTION ?? "0.000005";

console.log(
  `[formula-mode] TENOR_SECONDS=${process.env.TENOR_SECONDS} ` +
    `P_FLOOR_FRACTION=${process.env.P_FLOOR_FRACTION}`,
);

import("./live-orca-test");
