/**
 * Monitor loop — polls the on-chain position + whirlpool state at a
 * fixed interval until expiry. A light helper that keeps the main
 * live-orca demo script free of boilerplate.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeWhirlpoolAccount,
  sqrtPriceX64ToPrice,
  estimateLiquidity,
} from "../../market-data/decoder";
import {
  estimateTokenAmounts,
  positionValueUsd,
} from "../../pricing-engine/position-value";

export interface MonitorTick {
  timestamp: Date;
  currentPrice: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  isInRange: boolean;
  minutesLeft: number;
}

export interface MonitorOptions {
  connection: Connection;
  whirlpoolAddress: PublicKey;
  positionLiquidity: bigint;
  sqrtPriceLower: bigint;
  sqrtPriceUpper: bigint;
  tickLower: number;
  tickUpper: number;
  entryValueUsd: number;
  expiryTs: number;
  intervalSeconds: number;
  onTick?: (t: MonitorTick) => void;
}

/** Sleep helper (not exported). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive the monitor loop until `expiryTs` is reached. Each tick decodes
 * the whirlpool and computes the position's current USD value.
 *
 * Caller supplies `onTick` for reporting (e.g. console.log); the manager
 * itself has no I/O opinions.
 */
export async function watchUntilExpiry(opts: MonitorOptions): Promise<void> {
  const {
    connection,
    whirlpoolAddress,
    positionLiquidity,
    sqrtPriceLower,
    sqrtPriceUpper,
    tickLower,
    tickUpper,
    entryValueUsd,
    expiryTs,
    intervalSeconds,
    onTick,
  } = opts;

  const startNow = Math.floor(Date.now() / 1000);
  const waitSeconds = Math.max(0, expiryTs - startNow);
  for (let elapsed = 0; elapsed < waitSeconds; elapsed += intervalSeconds) {
    const remaining = waitSeconds - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(intervalSeconds, remaining) * 1000);

    try {
      const wpNow = await connection.getAccountInfo(whirlpoolAddress);
      if (!wpNow) continue;
      const wpData = decodeWhirlpoolAccount(Buffer.from(wpNow.data));
      const currentPrice = sqrtPriceX64ToPrice(wpData.sqrtPrice);
      const { amountA: nowA, amountB: nowB } = estimateTokenAmounts(
        positionLiquidity,
        wpData.sqrtPrice,
        sqrtPriceLower,
        sqrtPriceUpper,
      );
      const currentValueUsd = positionValueUsd(nowA, nowB, currentPrice);
      const minutesLeft = Math.max(
        0,
        (expiryTs - Math.floor(Date.now() / 1000)) / 60,
      );
      onTick?.({
        timestamp: new Date(),
        currentPrice,
        currentValueUsd,
        unrealizedPnlUsd: currentValueUsd - entryValueUsd,
        isInRange:
          wpData.tickCurrentIndex >= tickLower &&
          wpData.tickCurrentIndex < tickUpper,
        minutesLeft,
      });
    } catch {
      // Swallow RPC errors — next tick will retry. The manager is not
      // responsible for fail-stop semantics; callers with stronger
      // guarantees should use a bot daemon (see clients/operator-service
      // on the offchain-emulator branch).
    }
  }
}

// estimateLiquidity re-export so callers can get everything from one place
export { estimateLiquidity };
