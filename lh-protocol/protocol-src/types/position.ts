/**
 * Position state — escrowed Orca Whirlpool CL position owned by the Position Escrow component.
 */

export enum PositionStatus {
  /** Position NFT is locked in protocol escrow */
  Locked = 1,
  /** Position released back to owner (certificate settled/expired) */
  Released = 2,
  /** Position closed (NFT burned or withdrawn) */
  Closed = 3,
}

export interface PositionState {
  /** Mint address of the Orca position NFT */
  positionMint: string;

  /** Owner (LP) wallet address */
  owner: string;

  /** SOL/USDC price at position registration (micro-USD, 6 decimals) */
  entryPriceE6: number;

  /** Lower tick of the CL position */
  lowerTick: number;

  /** Upper tick of the CL position */
  upperTick: number;

  /** Liquidity parameter L of the CL position */
  liquidity: bigint;

  /** Position value at entry in micro-USDC */
  entryValueE6: number;

  /** Current lifecycle status */
  status: PositionStatus;

  /** Certificate mint protecting this position (null if unprotected) */
  protectedBy: string | null;

  /** PDA bump seed */
  bump: number;
}
