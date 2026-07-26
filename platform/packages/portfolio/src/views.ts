/**
 * Pure view builders — no RPC, fully unit-testable.
 * Valuation math delegates to @lh/core (single source of truth, NFR-Q1).
 */

import {
  PositionData,
  WhirlpoolData,
  sqrtPriceX64ToPrice,
  tickToSqrtPriceX64,
} from "@lh/core/src/market-data/decoder";
import { estimateTokenAmounts } from "@lh/core/src/pricing-engine/position-value";
import { MAINNET_USDC_MINT, DEVNET_USDC_MINT } from "@lh/core/src/config/chain";
import {
  PortfolioPositionView,
  PortfolioSummary,
  ValueCurvePoint,
} from "./types";

const USDC_MINTS = new Set([
  MAINNET_USDC_MINT.toBase58(),
  DEVNET_USDC_MINT.toBase58(),
]);

/**
 * Convert a human price (token B per token A) to a Q64.64 sqrt price.
 * Generic-decimals counterpart of core's SOL/USDC-specific
 * `priceE6ToSqrtPriceX64`. Float sqrt is used — relative error ~1e-15,
 * ample for valuation/charting (settlement never uses this path).
 */
export function priceToSqrtPriceX64(
  price: number,
  decimalsA: number,
  decimalsB: number,
): bigint {
  if (price <= 0) throw new Error(`priceToSqrtPriceX64: price ${price} must be > 0`);
  const rawPrice = price * Math.pow(10, decimalsB - decimalsA);
  const sqrtRaw = Math.sqrt(rawPrice);
  // 48 fractional bits before the shift keeps quantization error below
  // float's own ~1e-15 relative precision for realistic pool prices.
  return BigInt(Math.round(sqrtRaw * 2 ** 48)) << 16n;
}

export interface BuildViewInput {
  positionAddress: string;
  position: PositionData;
  whirlpool: WhirlpoolData;
  whirlpoolAddress: string;
  decimalsA: number;
  decimalsB: number;
}

export function buildPositionView(input: BuildViewInput): PortfolioPositionView {
  const { position, whirlpool, decimalsA, decimalsB } = input;

  const sqrtLower = tickToSqrtPriceX64(position.tickLowerIndex);
  const sqrtUpper = tickToSqrtPriceX64(position.tickUpperIndex);
  const { amountA, amountB } = estimateTokenAmounts(
    position.liquidity,
    whirlpool.sqrtPrice,
    sqrtLower,
    sqrtUpper,
  );

  const price = sqrtPriceX64ToPrice(whirlpool.sqrtPrice, decimalsA, decimalsB);
  const priceLower = sqrtPriceX64ToPrice(sqrtLower, decimalsA, decimalsB);
  const priceUpper = sqrtPriceX64ToPrice(sqrtUpper, decimalsA, decimalsB);

  const valueQuote =
    (Number(amountA) / 10 ** decimalsA) * price +
    Number(amountB) / 10 ** decimalsB;

  return {
    positionAddress: input.positionAddress,
    positionMint: position.positionMint.toBase58(),
    whirlpool: input.whirlpoolAddress,
    tokenMintA: whirlpool.tokenMintA.toBase58(),
    tokenMintB: whirlpool.tokenMintB.toBase58(),
    decimalsA,
    decimalsB,
    tickLower: position.tickLowerIndex,
    tickUpper: position.tickUpperIndex,
    liquidity: position.liquidity,
    price,
    priceLower,
    priceUpper,
    inRange:
      whirlpool.tickCurrentIndex >= position.tickLowerIndex &&
      whirlpool.tickCurrentIndex < position.tickUpperIndex,
    amountA,
    amountB,
    valueQuote,
    isUsdcQuoted: USDC_MINTS.has(whirlpool.tokenMintB.toBase58()),
    feeOwedA: position.feeOwedA,
    feeOwedB: position.feeOwedB,
  };
}

/**
 * Position value at a single hypothetical price, via the exact CL
 * token-amount math (decimals-safe for any pair — unlike feeding raw
 * whirlpool liquidity into the abstract-unit V(S) formula).
 */
export function positionValueAtPrice(
  view: Pick<
    PortfolioPositionView,
    "liquidity" | "tickLower" | "tickUpper" | "decimalsA" | "decimalsB"
  >,
  price: number,
): number {
  const sqrtLower = tickToSqrtPriceX64(view.tickLower);
  const sqrtUpper = tickToSqrtPriceX64(view.tickUpper);
  const sqrtP = priceToSqrtPriceX64(price, view.decimalsA, view.decimalsB);
  const { amountA, amountB } = estimateTokenAmounts(
    view.liquidity,
    sqrtP,
    sqrtLower,
    sqrtUpper,
  );
  return (
    (Number(amountA) / 10 ** view.decimalsA) * price +
    Number(amountB) / 10 ** view.decimalsB
  );
}

/**
 * V(S) curve for the P&L-vs-price chart (FR-M5): position value across a
 * hypothetical price grid, computed with the exact CL token-amount math.
 */
export function buildValueCurve(
  view: Pick<
    PortfolioPositionView,
    "liquidity" | "tickLower" | "tickUpper" | "decimalsA" | "decimalsB"
  >,
  opts?: { points?: number; priceMin?: number; priceMax?: number },
): ValueCurvePoint[] {
  const sqrtLower = tickToSqrtPriceX64(view.tickLower);
  const sqrtUpper = tickToSqrtPriceX64(view.tickUpper);
  const priceLower = sqrtPriceX64ToPrice(sqrtLower, view.decimalsA, view.decimalsB);
  const priceUpper = sqrtPriceX64ToPrice(sqrtUpper, view.decimalsA, view.decimalsB);

  const points = opts?.points ?? 101;
  const priceMin = opts?.priceMin ?? priceLower * 0.7;
  const priceMax = opts?.priceMax ?? priceUpper * 1.3;
  if (!(priceMin > 0) || !(priceMax > priceMin)) {
    throw new Error(`buildValueCurve: invalid price grid [${priceMin}, ${priceMax}]`);
  }

  const curve: ValueCurvePoint[] = [];
  for (let i = 0; i < points; i++) {
    const price = priceMin + ((priceMax - priceMin) * i) / (points - 1);
    const sqrtP = priceToSqrtPriceX64(price, view.decimalsA, view.decimalsB);
    const { amountA, amountB } = estimateTokenAmounts(
      view.liquidity,
      sqrtP,
      sqrtLower,
      sqrtUpper,
    );
    const value =
      (Number(amountA) / 10 ** view.decimalsA) * price +
      Number(amountB) / 10 ** view.decimalsB;
    curve.push({ price, value });
  }
  return curve;
}

export function aggregatePortfolio(
  views: PortfolioPositionView[],
): PortfolioSummary {
  let totalValueUsd = 0;
  let inRangeCount = 0;
  let unpricedCount = 0;
  for (const v of views) {
    if (v.isUsdcQuoted) totalValueUsd += v.valueQuote;
    else unpricedCount++;
    if (v.inRange) inRangeCount++;
  }
  return {
    positionsCount: views.length,
    inRangeCount,
    totalValueUsd,
    unpricedCount,
  };
}
