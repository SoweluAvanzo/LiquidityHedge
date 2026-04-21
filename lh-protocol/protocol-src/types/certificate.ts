/**
 * Certificate state, template configuration, and quote result.
 *
 * Used by Orchestrator (certificate lifecycle), Pricing Engine
 * (template → quote), and Position Escrow Registry (certificate ↔ position linkage).
 */

export enum CertificateStatus {
  /** Certificate created but not yet active */
  Created = 0,
  /** Active: protection in force */
  Active = 1,
  /** Settled: non-zero cash flow occurred at expiry (LP↔RT) */
  Settled = 2,
  /** Expired: tenor elapsed with exactly zero payout (S_T = S_0, measure-zero) */
  Expired = 3,
}

export interface CertificateState {
  /** Position mint this certificate protects */
  positionMint: string;

  /** Buyer (LP) wallet */
  buyer: string;

  /** Pool this certificate draws from */
  pool: string;

  /** Template ID used for this certificate */
  templateId: number;

  /** SOL/USDC entry price at purchase (micro-USD) */
  entryPriceE6: number;

  /**
   * Lower barrier price (micro-USD).
   * Equals the lower bound of the LP's CL range: S_0 * (1 - widthBps / BPS).
   * Below this price the Liquidity Hedge payoff is floored at +Cap_down
   * (RT pays LP the maximum). The LP's position is fully token A below
   * this level and its USD value keeps falling linearly — that residual
   * tail loss is not covered by the hedge.
   */
  lowerBarrierE6: number;

  /** Position notional value at entry (micro-USDC) */
  notionalUsdc: number;

  /**
   * Downside cap: Cap_down = V(S_0) - V(p_l).
   * Maximum RT liability on this certificate — the quantity the pool
   * reserves against `activeCapUsdc`. The matching upside cap
   * Cap_up = V(p_u) - V(S_0) bounds the LP's settlement payment and is
   * always covered by the escrowed position's proceeds (which are
   * worth V(p_u) when S_T >= p_u).
   */
  capUsdc: number;

  /** Total premium paid by LP (micro-USDC) */
  premiumUsdc: number;

  /** Protocol fee deducted from premium (micro-USDC) */
  protocolFeeUsdc: number;

  /** Fee-split rate y frozen at purchase time */
  feeSplitRate: number;

  /** Expected weekly fees E[F] used in premium computation (micro-USDC) */
  expectedWeeklyFeesUsdc: number;

  /** Unix timestamp of certificate purchase */
  purchaseTs: number;

  /** Unix timestamp of certificate expiry (purchaseTs + tenorSeconds) */
  expiryTs: number;

  /** Current lifecycle status */
  state: CertificateStatus;

  /** Settlement price (filled at settlement, micro-USD) */
  settlementPriceE6?: number;

  /**
   * Signed payout at settlement (micro-USDC).
   *   > 0 ⇒ RT pool pays LP (downside realized)
   *   < 0 ⇒ LP pays RT pool (upside surrendered, covered by position proceeds)
   *   = 0 ⇒ S_T = S_0 exactly (measure-zero under GBM)
   */
  payoutUsdc?: number;

  /** Fee income transferred to RT pool (filled at settlement, micro-USDC) */
  rtFeeIncomeUsdc?: number;

  /** PDA bump seed */
  bump: number;
}

// ---------------------------------------------------------------------------
// Template configuration — product parameters (Pricing Engine input)
// ---------------------------------------------------------------------------

export interface TemplateConfig {
  /** Unique template identifier */
  templateId: number;

  /**
   * Position width in BPS (e.g. 1000 = +/-10%).
   * The barrier is derived from this: B = S_0 * (1 - widthBps / BPS).
   */
  widthBps: number;

  /** Certificate tenor in seconds (e.g. 604800 = 7 days) */
  tenorSeconds: number;

  /** Heuristic fair-value ceiling (micro-USDC) — safety bound */
  premiumCeilingUsdc: number;

  /** Expected daily LP fee rate for this width (BPS, e.g. 45 = 0.45%) */
  expectedDailyFeeBps: number;
}

// ---------------------------------------------------------------------------
// Quote result — Pricing Engine output
// ---------------------------------------------------------------------------

export interface QuoteResult {
  /** Final premium charged to LP (micro-USDC) */
  premiumUsdc: number;

  /** Fair value of the Liquidity Hedge payoff (micro-USDC), always >= 0 */
  fairValueUsdc: number;

  /** Effective volatility markup applied */
  effectiveMarkup: number;

  /** Fee discount: y * E[F] (micro-USDC) */
  feeDiscountUsdc: number;

  /** Downside cap Cap_down = V(S_0) - V(p_l) (micro-USDC) */
  capUsdc: number;

  /** Barrier price = lower bound of CL range (micro-USD) */
  barrierE6: number;

  /** Entry price used for the quote (micro-USD) */
  entryPriceE6: number;
}
