/**
 * Portfolio view types — the read-model the Monitor module serves (FR-M2/M4).
 * All native token quantities stay bigint; human-unit numbers are derived
 * and clearly suffixed.
 */

export interface PortfolioPositionView {
  /** Orca position account address (PDA). */
  positionAddress: string;
  /** Position NFT mint held by the wallet. */
  positionMint: string;
  whirlpool: string;
  tokenMintA: string;
  tokenMintB: string;
  decimalsA: number;
  decimalsB: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** Current pool price, token B per token A, decimal-adjusted (human). */
  price: number;
  /** Range bounds as human prices (token B per token A). */
  priceLower: number;
  priceUpper: number;
  inRange: boolean;
  /** Current holdings in native units (A: base-token smallest unit, B: quote). */
  amountA: bigint;
  amountB: bigint;
  /** Position value expressed in token B human units (== USD iff B is USDC). */
  valueQuote: number;
  /** True when token B is USDC, i.e. valueQuote is a USD value. */
  isUsdcQuoted: boolean;
  /**
   * Fees owed as last checkpointed ON-CHAIN. Stale until the pool's
   * update_fees_and_rewards has run — treat as a lower bound (FR-M2 note).
   */
  feeOwedA: bigint;
  feeOwedB: bigint;
}

export interface PortfolioSummary {
  positionsCount: number;
  inRangeCount: number;
  /** Sum of valueQuote across USDC-quoted positions only. */
  totalValueUsd: number;
  /** Number of positions excluded from the USD total (non-USDC quote). */
  unpricedCount: number;
}

export interface ValueCurvePoint {
  /** Hypothetical price (token B per token A, human). */
  price: number;
  /** Position value at that price, token B human units. */
  value: number;
}
