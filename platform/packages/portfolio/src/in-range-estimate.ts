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
  /** §1.5: 90% block-bootstrap CI for `mean` itself (optional for
   *  older callers; always supplied by the viability pipeline). */
  meanCi?: { p05: number; p95: number };
  /** §1.5: windows/horizonSteps — the honest evidence count. */
  nEffective?: number;
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
  /** OUTCOME distribution across historical windows (how a single
   *  realized window can land — legitimately wide). NOT the precision
   *  of `fraction`; that is `meanCi` (§1.5). Empirical only. */
  band: { p05: number; p95: number } | null;
  /** §1.5: 90% block-bootstrap CI for `fraction` itself — the honest
   *  interval on the estimate the yield chain consumes. */
  meanCi: { p05: number; p95: number } | null;
  /** §1.5: effective sample size (windows ÷ horizon — overlapping
   *  windows share horizon−1 of horizon days). Quote THIS, not the raw
   *  window count, as the weight of evidence. */
  nEffective: number | null;
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
      meanCi: null,
      nEffective: null,
      reference: null,
      divergence: null,
      modelRiskFlag: false,
      description: gbmDescription(`empirical estimator unavailable (${reason})`),
      fallbackReason: reason,
    };
  }

  const divergence =
    gbm.fraction > 0 ? Math.abs(empirical.mean - gbm.fraction) / gbm.fraction : null;
  // §1.5: the raw window count overstates the evidence horizon-fold
  // (adjacent windows share horizon−1 of horizon days) — the verbatim
  // description states the effective count next to it.
  const evidence =
    empirical.nEffective !== undefined
      ? `${empirical.windows} rolling historical windows (≈${empirical.nEffective} effective — ` +
        `windows overlap ${empirical.horizonSteps - 1} of ${empirical.horizonSteps} days)`
      : `${empirical.windows} rolling historical windows`;
  return {
    fraction: empirical.mean,
    method: "empirical",
    band: { p05: empirical.p05, p95: empirical.p95 },
    meanCi: empirical.meanCi ?? null,
    nEffective: empirical.nEffective ?? null,
    reference: { method: "gbm-analytic", fraction: gbm.fraction },
    divergence,
    modelRiskFlag: divergence !== null && divergence > MODEL_RISK_THRESHOLD,
    description:
      `Empirical: measured over ${evidence} — ` +
      `for a range of this width started at each window's opening price, the ` +
      `realized fraction of the following ${empirical.horizonSteps} steps spent ` +
      `in range. No price model assumed.`,
    fallbackReason: null,
  };
}
