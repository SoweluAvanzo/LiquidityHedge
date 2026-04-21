/**
 * Pool state — the USDC protection pool underwritten by Risk Takers.
 */

export interface PoolState {
  /** Total USDC reserves held in the pool vault (micro-USDC) */
  reservesUsdc: number;

  /** Total outstanding share tokens */
  totalShares: number;

  /** Sum of capUsdc across all active certificates (micro-USDC) */
  activeCapUsdc: number;

  /** Maximum utilization ratio (BPS): activeCapUsdc / reservesUsdc <= uMaxBps / BPS */
  uMaxBps: number;

  /** Minimum volatility markup m_vol (e.g. 1.05) */
  markupFloor: number;

  /** Fee-split rate y in [0, 1]: share of LP fees transferred to RT */
  feeSplitRate: number;

  /** Expected daily LP fee rate (fraction of position value, e.g. 0.005) */
  expectedDailyFee: number;

  /**
   * Premium floor P_floor in micro-USDC — governance parameter.
   * The premium is: max(P_floor, FV * m_vol - y * E[F]).
   * Governance must set P_floor >= r_opp * Cap * T for RT participation.
   */
  premiumFloorUsdc: number;

  /** Protocol treasury fee on premiums (BPS) */
  protocolFeeBps: number;

  /** PDA bump seed */
  bump: number;
}
