/**
 * Viability Index (FR-M8): VI = r_measured / r_breakeven.
 *
 * r_breakeven here is the MODEL-BASED corridor breakeven — the daily fee
 * yield at which expected fee income (net of the fee split) exactly covers
 * the certificate's cost above fair value:
 *
 *      F·(1−y) + FV = Premium
 *
 * With the canonical premium this closes in two branches:
 *   formula-bound (Premium = FV·m_vol − y·F):  F* = FV·(m_vol − 1)
 *   floor-bound   (Premium = P_floor):          F* = (P_floor − FV)/(1−y)
 *
 * Scope note (documented for reconciliation with the paper's §8.5
 * empirical two-sided breakeven): this excludes the below-range residual
 * leg (V linear below p_l is outside the corridor hedge by design) and
 * IL-vs-hold effects — it prices "does fee income beat the markup drag",
 * which is the decision-relevant question at purchase time.
 */

export interface ViabilityInput {
  /** Fair value of the certificate payoff, USD. */
  fairValueUsd: number;
  /** Effective markup m_vol (≥ 1). */
  effectiveMarkup: number;
  /** Premium floor, USD. */
  premiumFloorUsd: number;
  /** Fee split rate y ∈ [0, 1). */
  feeSplitRate: number;
  /** Position value V(S₀), USD. */
  positionValueUsd: number;
  tenorDays: number;
  /** Measured position fee yield, per day (e.g. 0.0032 = 0.32%/day). */
  measuredDailyYield: number;
}

export interface ViabilityResult {
  /** Breakeven fee income over the tenor, USD. */
  breakevenFeesUsd: number;
  /** Breakeven daily yield on position value. */
  breakevenDailyYield: number;
  /** measured / breakeven; Infinity when breakeven is 0. */
  viabilityIndex: number;
  /** Which premium branch bound the breakeven. */
  bound: "formula" | "floor";
}

export function computeViability(input: ViabilityInput): ViabilityResult {
  const { fairValueUsd, effectiveMarkup, premiumFloorUsd, feeSplitRate } = input;
  if (input.positionValueUsd <= 0 || input.tenorDays <= 0) {
    throw new Error("viability: positionValueUsd and tenorDays must be > 0");
  }
  if (feeSplitRate < 0 || feeSplitRate >= 1) {
    throw new Error(`viability: feeSplitRate ${feeSplitRate} out of [0, 1)`);
  }

  // Determine the binding branch at the breakeven fee level itself:
  // formula-branch premium evaluated at its own breakeven F* = FV·(m_vol−1)
  // is FV·m_vol − y·F*; the floor binds when that is below P_floor.
  const fFormula = fairValueUsd * (effectiveMarkup - 1);
  const premiumAtFormulaBreakeven =
    fairValueUsd * effectiveMarkup - feeSplitRate * fFormula;

  let breakevenFeesUsd: number;
  let bound: "formula" | "floor";
  if (premiumAtFormulaBreakeven >= premiumFloorUsd) {
    breakevenFeesUsd = fFormula;
    bound = "formula";
  } else {
    breakevenFeesUsd = Math.max(
      0,
      (premiumFloorUsd - fairValueUsd) / (1 - feeSplitRate),
    );
    bound = "floor";
  }

  const breakevenDailyYield =
    breakevenFeesUsd / (input.positionValueUsd * input.tenorDays);
  return {
    breakevenFeesUsd,
    breakevenDailyYield,
    viabilityIndex:
      breakevenDailyYield === 0
        ? Infinity
        : input.measuredDailyYield / breakevenDailyYield,
    bound,
  };
}
