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

// ---------------------------------------------------------------------------
// Two-sided viability (paper §2.4.3–2.4.4) — INCLUDES divergence loss
// ---------------------------------------------------------------------------

/**
 * The paper's two-sided breakeven yield `r*`, which the index above does
 * NOT compute. The two answer different questions and are both useful:
 *
 *   computeViability()          "do fees beat the hedge's markup drag?"
 *                               F·(1−y) + FV = Premium.  NO ΔV term.
 *
 *   computeTwoSidedViability()  "is the position viable at all, for BOTH
 *                               sides, once divergence loss is counted?"
 *                               Σ(ΔV_w + V_w·r*·7) = φ Σ P_w.
 *
 * Derivation (§2.4.2–2.4.4). Unhedged weekly LP PnL is `U_w = ΔV_w + F_w`.
 * The certificate is a pure redistribution: premium, payoff and fee split
 * all cancel between LP and RT, so the ONLY leakage is the protocol fee
 * `φP_w`. Two-sided viability therefore needs `Σ U_w ≥ φ Σ P_w` (*), and
 * the breakeven sets that to equality. With `F_w = V_w·r·T`:
 *
 *      ΔV + V·r*·T = φ·P      ⟹   r* = (φ·P − ΔV) / (V·T)
 *
 * and with φ = 0 this collapses to the UNHEDGED breakeven
 * `r_u = −ΔV/(V·T)` — fees exactly offsetting divergence loss. The gap
 * `r* − r_u = φP/(V·T)` is Corollary 2.1's wedge, and is tiny (the paper
 * measures < 0.65 bps/day across its sensitivity grid).
 *
 * ΔV is NEGATIVE for a concave value function under a martingale price, so
 * `−ΔV > 0` and `r*` is materially larger than the markup-drag breakeven.
 * That is the whole point: this index is the honest one about whether
 * providing the liquidity pays at all.
 *
 * PREMIUM CONVENTION: `P` is evaluated at the MEASURED fee yield — the
 * premium this LP would actually pay today — mirroring the paper, whose
 * `Σ P_w` are realised premiums from the backtest. Solving the fixed point
 * in r instead would move `r*` by less than the wedge itself.
 */
export interface TwoSidedViabilityInput {
  /** E[ΔV] over the tenor, USD. Negative for a concave position. */
  expectedValueChangeUsd: number;
  /** Premium actually payable at the measured fee yield, USD. */
  premiumUsd: number;
  /** Protocol fee rate φ (e.g. 0.015). */
  protocolFeeRate: number;
  positionValueUsd: number;
  tenorDays: number;
  measuredDailyYield: number;
}

export interface TwoSidedViabilityResult {
  /** E[ΔV] over the tenor, USD (negative = divergence loss). */
  expectedValueChangeUsd: number;
  /** Unhedged breakeven r_u = −ΔV/(V·T): fees vs divergence loss alone. */
  unhedgedBreakevenDailyYield: number;
  /** Two-sided breakeven r* = r_u + φP/(V·T). */
  breakevenDailyYield: number;
  /** r* − r_u, Corollary 2.1's protocol-fee wedge. */
  protocolFeeWedgeDailyYield: number;
  /** measured / r*. Infinity when r* ≤ 0 (divergence loss is a gain). */
  viabilityIndex: number;
}

export function computeTwoSidedViability(
  input: TwoSidedViabilityInput,
): TwoSidedViabilityResult {
  const { positionValueUsd: V, tenorDays: T, protocolFeeRate: phi } = input;
  if (V <= 0 || T <= 0) {
    throw new Error("two-sided viability: positionValueUsd and tenorDays must be > 0");
  }
  if (phi < 0 || phi >= 1) {
    throw new Error(`two-sided viability: protocolFeeRate ${phi} out of [0, 1)`);
  }

  const dV = input.expectedValueChangeUsd;
  const unhedged = -dV / (V * T);
  const wedge = (phi * input.premiumUsd) / (V * T);
  const rStar = unhedged + wedge;

  return {
    expectedValueChangeUsd: dV,
    unhedgedBreakevenDailyYield: unhedged,
    breakevenDailyYield: rStar,
    protocolFeeWedgeDailyYield: wedge,
    // r* ≤ 0 means the position is expected to GAIN value over the tenor,
    // so any positive fee income clears the bar — unbounded, not an error.
    viabilityIndex: rStar > 0 ? input.measuredDailyYield / rStar : Infinity,
  };
}
