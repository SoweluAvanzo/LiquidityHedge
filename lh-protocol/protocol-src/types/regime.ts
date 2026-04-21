/**
 * Regime snapshot — Risk Analyser output. Consumed by Pricing Engine
 * to produce the FV and premium.
 */

export interface RegimeSnapshot {
  /** Pool this snapshot belongs to */
  pool: string;

  /** 30-day annualized realized volatility (PPM) */
  sigmaPpm: number;

  /** 7-day annualized realized volatility (PPM) */
  sigma7dPpm: number;

  /** Stress flag: true during elevated-risk regimes */
  stressFlag: boolean;

  /** Daily carry cost in basis points */
  carryBpsPerDay: number;

  /**
   * Calibrated severity for the heuristic fair-value proxy (PPM).
   * Adjusted so that the heuristic approximates the GH quadrature FV.
   */
  severityPpm: number;

  /** Implied-to-realized volatility ratio (e.g. 1.08) */
  ivRvRatio: number;

  /** Resolved effective markup: max(markupFloor, ivRvRatio) */
  effectiveMarkup: number;

  /** Unix timestamp of last update */
  updatedAt: number;

  /** PDA bump seed */
  bump: number;
}
