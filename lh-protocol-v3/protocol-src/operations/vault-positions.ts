/**
 * Position management operations: register, release, close.
 *
 * These operations manage the escrow lifecycle of Orca Whirlpool position
 * NFTs within the protocol. An LP locks a position NFT to enable hedge
 * certificate purchase, and releases it after settlement or expiry.
 *
 * v3: No changes from v2. The position lifecycle is orthogonal to the
 * pricing and premium model changes in v3.
 */

import {
  PositionState,
  PositionStatus,
  RegisterPositionParams,
} from "../types";

// ─── State Store Interface ───────────────────────────────────────────

export interface PositionStore {
  getPosition(mint: string): PositionState | null;
  addPosition(pos: PositionState): void;
  updatePosition(mint: string, fn: (pos: PositionState) => void): void;
  removePosition(mint: string): void;
}

// ─── Register Locked Position ────────────────────────────────────────

/**
 * Register a locked Orca Whirlpool position in the protocol.
 *
 * Preconditions:
 * - The position NFT must be held by the vault (escrow)
 * - No duplicate registration for the same mint
 *
 * The position starts in LOCKED status. Once locked, the LP can purchase
 * a hedge certificate referencing this position.
 *
 * @param store   Position state store
 * @param owner   LP owner's public key (base58)
 * @param params  Position parameters (mint, ticks, price)
 * @returns The registered PositionState
 */
export function registerLockedPosition(
  store: PositionStore,
  owner: string,
  params: RegisterPositionParams,
): PositionState {
  const mintStr = params.positionMint;

  if (store.getPosition(mintStr)) {
    throw new Error(`Position already registered: ${mintStr}`);
  }

  const pos: PositionState = {
    owner,
    whirlpool: params.whirlpool,
    positionMint: mintStr,
    lowerTick: params.lowerTick,
    upperTick: params.upperTick,
    p0PriceE6: params.p0PriceE6,
    liquidity: "0", // set by caller after on-chain read
    protectedBy: null,
    status: PositionStatus.LOCKED,
  };

  store.addPosition(pos);
  return pos;
}

// ─── Release Position ────────────────────────────────────────────────

/**
 * Release a locked position back to the owner.
 *
 * Preconditions:
 * - Position must be in LOCKED status
 * - Position must NOT be protected by an active certificate
 *
 * After release, the position NFT can be transferred back to the LP.
 *
 * @param store  Position state store
 * @param mint   Position mint (base58)
 * @param owner  Caller's public key (must match position owner)
 */
export function releasePosition(
  store: PositionStore,
  mint: string,
  owner: string,
): void {
  const pos = store.getPosition(mint);
  if (!pos) throw new Error(`Position not found: ${mint}`);
  if (pos.owner !== owner) throw new Error("Unauthorized");
  if (pos.status !== PositionStatus.LOCKED) {
    throw new Error(`Position not locked: status=${pos.status}`);
  }
  if (pos.protectedBy !== null) {
    throw new Error(
      `Position still protected by certificate: ${pos.protectedBy}`
    );
  }

  store.updatePosition(mint, (p) => {
    p.status = PositionStatus.RELEASED;
  });
}

// ─── Close Position ──────────────────────────────────────────────────

/**
 * Mark a position as closed. Called after the Orca position has been
 * closed on-chain and liquidity withdrawn.
 *
 * Preconditions:
 * - Position must be in RELEASED status
 * - Position must NOT be protected
 *
 * @param store  Position state store
 * @param mint   Position mint (base58)
 * @param owner  Caller's public key (must match position owner)
 */
export function closePosition(
  store: PositionStore,
  mint: string,
  owner: string,
): void {
  const pos = store.getPosition(mint);
  if (!pos) throw new Error(`Position not found: ${mint}`);
  if (pos.owner !== owner) throw new Error("Unauthorized");
  if (pos.status !== PositionStatus.RELEASED) {
    throw new Error(`Position not released: status=${pos.status}`);
  }
  if (pos.protectedBy !== null) {
    throw new Error("Position still protected");
  }

  store.updatePosition(mint, (p) => {
    p.status = PositionStatus.CLOSED;
  });
}

// ─── Query Helpers ───────────────────────────────────────────────────

/**
 * Check whether a position can have a certificate purchased against it.
 */
export function isPositionHedgeable(pos: PositionState): boolean {
  return pos.status === PositionStatus.LOCKED && pos.protectedBy === null;
}

/**
 * Check whether a position can be released (no active certificate).
 */
export function isPositionReleasable(pos: PositionState): boolean {
  return pos.status === PositionStatus.LOCKED && pos.protectedBy === null;
}
