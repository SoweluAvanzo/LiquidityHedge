/**
 * Pool operations: init, deposit, withdraw.
 * NAV-based share pricing -- exact port of pool/instructions.rs.
 *
 * v3 changes from v2:
 * - initPool accepts feeSplitRate and expectedDailyFee (no premiumMode/alpha)
 * - PoolState carries feeSplitRate, expectedDailyFee, markupFloor
 * - depositUsdc / withdrawUsdc logic is unchanged from v1/v2
 * - Removed premiumMode and twoPartAlpha fields
 *
 * The RT revenue model in v3:
 * - Premiums flow into reserves at certificate purchase time
 * - Fee split income flows into reserves at settlement time
 * - Share price rises as premium + fee split income exceeds payouts
 * - RT earns: premium income + fee split income - certificate payouts
 */

import {
  PoolState,
  PoolInitConfig,
  DepositResult,
  WithdrawResult,
  BPS,
  DEFAULT_FEE_SPLIT_RATE,
  DEFAULT_EXPECTED_DAILY_FEE,
  DEFAULT_MARKUP_FLOOR,
} from "../types";

// ─── In-Memory State Store ───────────────────────────────────────────

/**
 * Minimal in-memory state container for pool operations.
 * In a real deployment, this would be backed by Solana account reads.
 */
export interface PoolStore {
  getPool(): PoolState | null;
  setPool(pool: PoolState): void;
  updatePool(fn: (pool: PoolState) => void): void;
  getShares(owner: string): number;
  addShares(owner: string, amount: number): void;
  removeShares(owner: string, amount: number): void;
}

// ─── Pool Initialization ─────────────────────────────────────────────

/**
 * Initialize the USDC protection pool.
 *
 * v3 pool configuration:
 * - feeSplitRate:        fraction of LP fees flowing to RT at settlement (default 0.10)
 * - expectedDailyFee:    expected daily fee rate for premium discount (default 0.005)
 * - markupFloor:         minimum effective markup (default 1.05)
 * - protocolFeeBps:      protocol treasury fee (default 150 = 1.5%)
 *
 * @param store   State store for pool data
 * @param config  Full pool initialization config
 */
export function initPool(
  store: PoolStore,
  config: PoolInitConfig,
): PoolState {
  if (store.getPool()) {
    throw new Error("Pool already initialized");
  }

  const pool: PoolState = {
    admin: config.admin,
    usdcMint: config.usdcMint,
    usdcVault: config.usdcVault,
    reservesUsdc: 0,
    activeCapUsdc: 0,
    totalShares: 0,
    uMaxBps: config.uMaxBps,
    feeSplitRate: config.feeSplitRate ?? DEFAULT_FEE_SPLIT_RATE,
    expectedDailyFee: config.expectedDailyFee ?? DEFAULT_EXPECTED_DAILY_FEE,
    markupFloor: config.markupFloor ?? DEFAULT_MARKUP_FLOOR,
    protocolFeeBps: config.protocolFeeBps ?? 150,
    treasuryPubkey: config.treasuryPubkey ?? "",
    protocolFeesCollected: 0,
  };

  store.setPool(pool);
  return pool;
}

// ─── Deposit ─────────────────────────────────────────────────────────

/**
 * Deposit USDC into the pool. Returns the number of shares minted.
 *
 * NAV-based share calculation (from pool/instructions.rs:128-136):
 * - First deposit: shares = amount (1:1)
 * - Subsequent: shares = amount * totalShares / reservesUsdc
 *
 * Premiums and fee split income flowing into reserves cause share value
 * to rise over time, so later depositors get fewer shares per USDC.
 * This is the core RT income mechanism.
 *
 * @param store      State store
 * @param depositor  Depositor's public key (base58)
 * @param amount     Micro-USDC to deposit
 * @returns Number of shares minted
 */
export function depositUsdc(
  store: PoolStore,
  depositor: string,
  amount: number,
): DepositResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");
  if (amount <= 0) throw new Error("Amount must be positive");

  // NAV-based share calculation
  let shares: number;
  if (pool.totalShares === 0 || pool.reservesUsdc === 0) {
    shares = amount; // 1:1 for first deposit
  } else {
    shares = Math.floor((amount * pool.totalShares) / pool.reservesUsdc);
  }
  if (shares <= 0) throw new Error("Shares must be positive");

  // Update state
  store.updatePool((p) => {
    p.reservesUsdc += amount;
    p.totalShares += shares;
  });
  store.addShares(depositor, shares);

  return { shares };
}

// ─── Withdraw ────────────────────────────────────────────────────────

/**
 * Withdraw USDC by burning shares.
 *
 * Includes utilization guard: post-withdrawal reserves must be sufficient
 * to back the active cap commitment (from pool/instructions.rs:249-263).
 *
 * Formula:
 *   usdcToReturn = sharesToBurn * reservesUsdc / totalShares
 *   postReserves >= activeCapUsdc * BPS / uMaxBps
 *
 * @param store        State store
 * @param withdrawer   Withdrawer's public key (base58)
 * @param sharesToBurn Number of shares to burn
 * @returns Micro-USDC returned
 */
export function withdrawUsdc(
  store: PoolStore,
  withdrawer: string,
  sharesToBurn: number,
): WithdrawResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");
  if (sharesToBurn <= 0) throw new Error("Shares must be positive");

  const currentShares = store.getShares(withdrawer);
  if (currentShares < sharesToBurn) {
    throw new Error(
      `Insufficient shares: have ${currentShares}, want to burn ${sharesToBurn}`
    );
  }

  // NAV-based USDC return
  const usdcToReturn = Math.floor(
    (sharesToBurn * pool.reservesUsdc) / pool.totalShares
  );

  // Utilization guard
  if (pool.activeCapUsdc > 0) {
    const postReserves = pool.reservesUsdc - usdcToReturn;
    const minReserves = Math.ceil(
      (pool.activeCapUsdc * BPS) / pool.uMaxBps
    );
    if (postReserves < minReserves) {
      throw new Error(
        `WithdrawalWouldBreachUtilization: postReserves=${postReserves} < minReserves=${minReserves}`
      );
    }
  }

  // Update state
  store.updatePool((p) => {
    p.reservesUsdc -= usdcToReturn;
    p.totalShares -= sharesToBurn;
  });
  store.removeShares(withdrawer, sharesToBurn);

  return { usdcReturned: usdcToReturn };
}

// ─── Pool Queries ────────────────────────────────────────────────────

/**
 * Compute the current share price in micro-USDC.
 * Returns 1_000_000 (= $1.00) if pool is empty.
 */
export function sharePrice(pool: PoolState): number {
  if (pool.totalShares === 0) return 1_000_000;
  return Math.floor((pool.reservesUsdc * 1_000_000) / pool.totalShares);
}

/**
 * Current utilization as a fraction [0, 1].
 */
export function utilization(pool: PoolState): number {
  if (pool.reservesUsdc === 0) return 0;
  return pool.activeCapUsdc / pool.reservesUsdc;
}

/**
 * Available headroom in micro-USDC: how much additional cap can be underwritten.
 */
export function availableHeadroom(pool: PoolState): number {
  const maxCap = Math.floor((pool.reservesUsdc * pool.uMaxBps) / BPS);
  return Math.max(0, maxCap - pool.activeCapUsdc);
}
