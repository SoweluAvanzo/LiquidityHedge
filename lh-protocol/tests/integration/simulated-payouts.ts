/**
 * Simulated payout analysis — computes hypothetical payouts at various
 * price levels using the actual CL position parameters and the corridor formula.
 * Pure math, no RPC calls.
 */

import { SimulatedPayout } from "./types";
import {
  estimateTokenAmounts,
  positionValueUsd,
} from "../../clients/cli/position-value";
import {
  tickToSqrtPriceX64,
  priceToSqrtPriceX64,
} from "../../clients/cli/whirlpool-ix";

export interface SimulationParams {
  entryPrice: number;        // USD
  barrierPrice: number;      // USD
  capUsdc: number;           // micro-USDC
  premiumUsdc: number;       // micro-USDC
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  rtDepositUsdc: number;     // micro-USDC
}

/**
 * Compute payouts at price levels from -15% to +10% of entry.
 */
export function computeSimulatedPayouts(params: SimulationParams): SimulatedPayout[] {
  const {
    entryPrice, barrierPrice, capUsdc, premiumUsdc,
    liquidity, tickLower, tickUpper, rtDepositUsdc,
  } = params;

  const sqrtPriceLower = tickToSqrtPriceX64(tickLower);
  const sqrtPriceUpper = tickToSqrtPriceX64(tickUpper);

  // Entry value
  const sqrtPriceEntry = priceToSqrtPriceX64(entryPrice);
  const entryAmounts = estimateTokenAmounts(liquidity, sqrtPriceEntry, sqrtPriceLower, sqrtPriceUpper);
  const entryValueUsd = positionValueUsd(entryAmounts.amountA, entryAmounts.amountB, entryPrice);

  // Price levels: -15% to +10% in 1% steps, plus finer resolution around barrier
  const percentages = [
    10, 5, 2, 1, 0,
    -1, -2, -3, -4,
  ];

  // Add finer resolution around barrier
  const barrierPct = ((barrierPrice - entryPrice) / entryPrice) * 100;
  for (let p = Math.ceil(barrierPct) + 1; p >= Math.floor(barrierPct) - 2; p--) {
    if (!percentages.includes(p)) percentages.push(p);
  }

  // Add deeper drops
  for (const p of [-5, -6, -7, -8, -10, -15]) {
    if (!percentages.includes(p)) percentages.push(p);
  }

  percentages.sort((a, b) => b - a); // descending

  const results: SimulatedPayout[] = [];

  for (const changePct of percentages) {
    const priceUsd = entryPrice * (1 + changePct / 100);
    if (priceUsd <= 0) continue;

    let payoutUsdc = 0;
    let clPositionLossUsdc = 0;
    const barrierBreached = priceUsd < barrierPrice;

    if (priceUsd < entryPrice) {
      // Compute CL position loss
      const effectivePrice = Math.max(priceUsd, barrierPrice);
      const sqrtPriceSettle = priceToSqrtPriceX64(effectivePrice);
      const settleAmounts = estimateTokenAmounts(liquidity, sqrtPriceSettle, sqrtPriceLower, sqrtPriceUpper);
      const settleValueUsd = positionValueUsd(settleAmounts.amountA, settleAmounts.amountB, effectivePrice);
      const lossUsd = Math.max(0, entryValueUsd - settleValueUsd);
      clPositionLossUsdc = Math.floor(lossUsd * 1e6);
      payoutUsdc = Math.min(clPositionLossUsdc, capUsdc);
    }

    // LP net PnL: position PnL + payout - premium
    const sqrtPriceActual = priceToSqrtPriceX64(priceUsd);
    const actualAmounts = estimateTokenAmounts(liquidity, sqrtPriceActual, sqrtPriceLower, sqrtPriceUpper);
    const actualValueUsd = positionValueUsd(actualAmounts.amountA, actualAmounts.amountB, priceUsd);
    const positionPnlUsd = actualValueUsd - entryValueUsd;
    const lpNetPnlUsd = positionPnlUsd + payoutUsdc / 1e6 - premiumUsdc / 1e6;

    // RT PnL: premium earned - payout
    const rtPnlUsd = (premiumUsdc - payoutUsdc) / 1e6;

    results.push({
      priceUsd,
      changePct,
      barrierBreached,
      clPositionLossUsdc,
      payoutUsdc,
      lpNetPnlUsd,
      rtPnlUsd,
    });
  }

  return results;
}
