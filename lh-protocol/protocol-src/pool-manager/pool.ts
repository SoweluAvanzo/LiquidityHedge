/**
 * Liquidity Hedge Protocol — NAV-Based Protection Pool
 *
 * The pool holds USDC reserves deposited by Risk Takers (RTs).
 * Share tokens track each RT's pro-rata ownership of the reserves.
 * Premiums increase reserves (share price rises), payouts decrease them.
 *
 * Key formulas:
 *   Deposit:  shares = amount * totalShares / reservesUsdc  (or amount if first)
 *   Withdraw: usdc   = shares * reservesUsdc / totalShares
 *   Guard:    postReserves >= activeCapUsdc * BPS / uMaxBps
 */

import { BPS, PoolState } from "../types";
import { PoolInitConfig } from "../config/templates";
import { StateStore } from "../event-audit/store";

// ---------------------------------------------------------------------------
// Pool initialization
// ---------------------------------------------------------------------------

export interface InitPoolParams extends PoolInitConfig {
  admin: string;
}

export function initPool(store: StateStore, params: InitPoolParams): PoolState {
  if (store.getPool()) {
    throw new Error("Pool already initialized");
  }

  const pool: PoolState = {
    reservesUsdc: 0,
    totalShares: 0,
    activeCapUsdc: 0,
    uMaxBps: params.uMaxBps,
    markupFloor: params.markupFloor,
    feeSplitRate: params.feeSplitRate,
    expectedDailyFee: params.expectedDailyFee,
    premiumFloorUsdc: params.premiumFloorUsdc,
    protocolFeeBps: params.protocolFeeBps,
    bump: 255,
  };

  store.setPool(pool);
  return pool;
}

// ---------------------------------------------------------------------------
// Deposit USDC → mint shares
// ---------------------------------------------------------------------------

export interface DepositResult {
  shares: number;
  sharePriceBefore: number;
  sharePriceAfter: number;
}

/**
 * Deposit USDC into the pool and receive share tokens.
 *
 * Share pricing is NAV-based:
 *   - First deposit: 1 share = 1 micro-USDC (1:1)
 *   - Subsequent: shares = floor(amount * totalShares / reservesUsdc)
 *
 * This ensures that premiums collected between deposits increase the
 * share price, rewarding earlier depositors.
 *
 * @param store     - State store
 * @param depositor - RT wallet address
 * @param amount    - USDC amount in micro-USDC
 * @returns Deposit result with shares minted
 */
export function depositUsdc(
  store: StateStore,
  depositor: string,
  amount: number,
): DepositResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");
  if (amount <= 0) throw new Error("Amount must be positive");

  const priceBefore = sharePrice(pool);

  let shares: number;
  if (pool.totalShares === 0 || pool.reservesUsdc === 0) {
    shares = amount;
  } else {
    shares = Math.floor((amount * pool.totalShares) / pool.reservesUsdc);
  }

  if (shares <= 0) throw new Error("Deposit too small to mint shares");

  store.updatePool((p) => {
    p.reservesUsdc += amount;
    p.totalShares += shares;
  });
  store.addShares(depositor, shares);

  const priceAfter = sharePrice(store.getPool()!);

  return {
    shares,
    sharePriceBefore: priceBefore,
    sharePriceAfter: priceAfter,
  };
}

// ---------------------------------------------------------------------------
// Withdraw USDC ← burn shares
// ---------------------------------------------------------------------------

export interface WithdrawResult {
  usdcReturned: number;
  sharePriceBefore: number;
  sharePriceAfter: number;
}

/**
 * Withdraw USDC by burning share tokens.
 *
 * USDC returned = floor(sharesToBurn * reservesUsdc / totalShares)
 *
 * Guarded by utilization constraint:
 *   postReserves >= ceil(activeCapUsdc * BPS / uMaxBps)
 *
 * This prevents withdrawals that would leave the pool unable to
 * cover outstanding certificate liabilities.
 *
 * @param store     - State store
 * @param withdrawer - RT wallet address
 * @param sharesToBurn - Number of shares to redeem
 * @returns Withdrawal result
 */
export function withdrawUsdc(
  store: StateStore,
  withdrawer: string,
  sharesToBurn: number,
): WithdrawResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");
  if (sharesToBurn <= 0) throw new Error("Shares must be positive");

  const owned = store.getShares(withdrawer);
  if (owned < sharesToBurn) {
    throw new Error(
      `Insufficient shares: owns ${owned}, requested ${sharesToBurn}`,
    );
  }

  const priceBefore = sharePrice(pool);
  const usdcToReturn = Math.floor(
    (sharesToBurn * pool.reservesUsdc) / pool.totalShares,
  );

  // Utilization guard
  if (pool.activeCapUsdc > 0) {
    const postReserves = pool.reservesUsdc - usdcToReturn;
    const minReserves = Math.ceil(
      (pool.activeCapUsdc * BPS) / pool.uMaxBps,
    );
    if (postReserves < minReserves) {
      throw new Error(
        `Withdrawal would breach utilization: postReserves=${postReserves} < minReserves=${minReserves}`,
      );
    }
  }

  store.updatePool((p) => {
    p.reservesUsdc -= usdcToReturn;
    p.totalShares -= sharesToBurn;
  });
  store.removeShares(withdrawer, sharesToBurn);

  const priceAfter = sharePrice(store.getPool()!);

  return {
    usdcReturned: usdcToReturn,
    sharePriceBefore: priceBefore,
    sharePriceAfter: priceAfter,
  };
}

// ---------------------------------------------------------------------------
// Pool queries
// ---------------------------------------------------------------------------

/**
 * Current share price in micro-USDC.
 * Returns 1_000_000 ($1.00) for empty pools.
 */
export function sharePrice(pool: PoolState): number {
  if (pool.totalShares === 0) return 1_000_000;
  return Math.floor((pool.reservesUsdc * 1_000_000) / pool.totalShares);
}

/**
 * Current utilization ratio: activeCapUsdc / reservesUsdc.
 * Returns 0 if pool is empty.
 */
export function utilization(pool: PoolState): number {
  if (pool.reservesUsdc === 0) return 0;
  return pool.activeCapUsdc / pool.reservesUsdc;
}

/**
 * Available headroom: how much additional cap the pool can underwrite.
 *
 * headroom = floor(reservesUsdc * uMaxBps / BPS) - activeCapUsdc
 */
export function availableHeadroom(pool: PoolState): number {
  const maxCap = Math.floor((pool.reservesUsdc * pool.uMaxBps) / BPS);
  return Math.max(0, maxCap - pool.activeCapUsdc);
}
