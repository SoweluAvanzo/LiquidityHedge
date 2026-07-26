/**
 * In-range estimator composition — the transparency contract.
 *
 * Policy (agreed 2026-07-08): empirical estimator is PRIMARY when history
 * allows; GBM analytic is the pricing-consistent REFERENCE; disagreement
 * between them is surfaced as a model-risk signal, never averaged away.
 * Every result carries which method produced it and a plain-language
 * description — the frontend must show these verbatim.
 */

export interface EmpiricalInRangeInput {
  mean: number;
  p05: number;
  p95: number;
  windows: number;
  horizonSteps: number;
}

export interface GbmInRangeInput {
  fraction: number;
  sigmaAnnual: number;
}

export type InRangeMethod = "empirical" | "gbm-analytic";

export interface InRangeEstimate {
  /** The fraction to USE (primary estimator). */
  fraction: number;
  method: InRangeMethod;
  /** Uncertainty band (empirical only; null for model-based). */
  band: { p05: number; p95: number } | null;
  /** The other estimator's value, for side-by-side display. */
  reference: { method: InRangeMethod; fraction: number } | null;
  /** |empirical − gbm| / gbm when both exist. */
  divergence: number | null;
  /** True when divergence exceeds the model-risk threshold. */
  modelRiskFlag: boolean;
  /** Plain-language description of the PRIMARY method — display verbatim. */
  description: string;
  /** Why the empirical estimator was unavailable (fallback case only). */
  fallbackReason: string | null;
}

/** Divergence above this (relative) raises the model-risk flag. */
export const MODEL_RISK_THRESHOLD = 0.15;

/** Fewer rolling windows than this → empirical too noisy to lead. */
export const MIN_EMPIRICAL_WINDOWS = 60;

export function composeInRangeEstimate(inputs: {
  empirical: EmpiricalInRangeInput | null;
  gbm: GbmInRangeInput;
  /** Required when empirical is null or below the window minimum. */
  empiricalUnavailableReason?: string;
}): InRangeEstimate {
  const { empirical, gbm } = inputs;
  const gbmDescription = (why: string) =>
    `Model-based (GBM): expected in-range time under a lognormal price model ` +
    `with σ=${(gbm.sigmaAnnual * 100).toFixed(0)}%/yr — ${why}`;

  if (!empirical || empirical.windows < MIN_EMPIRICAL_WINDOWS) {
    const reason =
      inputs.empiricalUnavailableReason ??
      (empirical
        ? `only ${empirical.windows} historical windows (min ${MIN_EMPIRICAL_WINDOWS})`
        : "no market history available");
    return {
      fraction: gbm.fraction,
      method: "gbm-analytic",
      band: null,
      reference: null,
      divergence: null,
      modelRiskFlag: false,
      description: gbmDescription(`empirical estimator unavailable (${reason})`),
      fallbackReason: reason,
    };
  }

  const divergence =
    gbm.fraction > 0 ? Math.abs(empirical.mean - gbm.fraction) / gbm.fraction : null;
  return {
    fraction: empirical.mean,
    method: "empirical",
    band: { p05: empirical.p05, p95: empirical.p95 },
    reference: { method: "gbm-analytic", fraction: gbm.fraction },
    divergence,
    modelRiskFlag: divergence !== null && divergence > MODEL_RISK_THRESHOLD,
    description:
      `Empirical: measured over ${empirical.windows} rolling historical windows — ` +
      `for a range of this width started at each window's opening price, the ` +
      `realized fraction of the following ${empirical.horizonSteps} steps spent ` +
      `in range. No price model assumed.`,
    fallbackReason: null,
  };
}
