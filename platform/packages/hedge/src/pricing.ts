/**
 * Decimals-safe certificate pricing.
 *
 * The prototype's `computeQuote` feeds RAW whirlpool liquidity into the
 * abstract-unit V(S) formula — consistent within itself but not in real
 * USD for arbitrary token decimals (prototype quirk E9). The product
 * quotes REAL dollars, so FV and caps here are computed from the exact
 * token-amount valuation (`positionValueAtPrice`), with the same
 * composite-Simpson quadrature (N=200 over z∈[−6,6]) and the same
 * canonical premium formula as the paper.
 */

import { positionValueAtPrice } from "@lh/portfolio";
import { computePremium, computeFeeDiscount } from "@lh/core/src/pricing-engine/pricing";
import { tickToSqrtPriceX64, sqrtPriceX64ToPrice } from "@lh/core/src/market-data/decoder";
import { HedgedPositionInput } from "./types";

const SECONDS_PER_YEAR = 365 * 86_400;
const Z_BOUND = 6;
const SIMPSON_N = 200;

function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

export interface PositionGeometry {
  priceLowerUsd: number;
  priceUpperUsd: number;
  entryValueUsd: number;
  capDownUsd: number;
  capUpUsd: number;
}

export function positionGeometry(pos: HedgedPositionInput): PositionGeometry {
  const pL = sqrtPriceX64ToPrice(
    tickToSqrtPriceX64(pos.tickLower),
    pos.decimalsA,
    pos.decimalsB,
  );
  const pU = sqrtPriceX64ToPrice(
    tickToSqrtPriceX64(pos.tickUpper),
    pos.decimalsA,
    pos.decimalsB,
  );
  const S0 = pos.currentPriceUsd;
  if (!(S0 > pL && S0 < pU)) {
    throw new Error(
      `position must be in range to hedge: S0=${S0} not in (${pL}, ${pU})`,
    );
  }
  const v = (p: number) => positionValueAtPrice(pos, p);
  const entryValueUsd = v(S0);
  return {
    priceLowerUsd: pL,
    priceUpperUsd: pU,
    entryValueUsd,
    capDownUsd: Math.max(0, entryValueUsd - v(pL)),
    capUpUsd: Math.max(0, v(pU) - entryValueUsd),
  };
}

/**
 * FV = E_Q[Π(S_T)] with Π = V(S₀) − V(clamp(S_T, p_l, p_u)), risk-neutral
 * GBM, composite Simpson — the decimals-safe twin of the prototype's
 * `computeQuadratureFV`, deterministic and replayable.
 */
export function computeSafeFVUsd(
  pos: HedgedPositionInput,
  geometry: PositionGeometry,
  sigmaAnnual: number,
  tenorSeconds: number,
): number {
  const S0 = pos.currentPriceUsd;
  const tenor = tenorSeconds / SECONDS_PER_YEAR;
  const drift = -0.5 * sigmaAnnual * sigmaAnnual * tenor;
  const vol = sigmaAnnual * Math.sqrt(tenor);
  const h = (2 * Z_BOUND) / SIMPSON_N;
  const { priceLowerUsd: pL, priceUpperUsd: pU, entryValueUsd } = geometry;

  const integrand = (z: number): number => {
    const ST = S0 * Math.exp(drift + vol * z);
    const clamped = Math.min(Math.max(ST, pL), pU);
    return (entryValueUsd - positionValueAtPrice(pos, clamped)) * normalPdf(z);
  };

  let sum = integrand(-Z_BOUND) + integrand(Z_BOUND);
  for (let i = 1; i < SIMPSON_N; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * integrand(-Z_BOUND + i * h);
  }
  return Math.max(0, (h / 3) * sum);
}

export interface PriceQuoteInputs {
  sigmaAnnual: number;
  ivRvRatio: number;
  markupFloor: number;
  feeSplitRate: number;
  expectedDailyFee: number;
  premiumFloorUsdc: number;
  tenorSeconds: number;
}

export interface PriceQuoteResult {
  premiumUsdc: number;
  fairValueUsdc: number;
  effectiveMarkup: number;
  feeDiscountUsdc: number;
  capDownUsdc: number;
  capUpUsdc: number;
  entryValueUsdc: number;
}

/** Canonical premium on decimals-safe inputs. Collateral (capUp) is
 *  rounded UP so the truncated settlement payoff can never exceed it. */
export function priceCertificate(
  pos: HedgedPositionInput,
  inputs: PriceQuoteInputs,
): PriceQuoteResult {
  const geometry = positionGeometry(pos);
  const fvUsd = computeSafeFVUsd(pos, geometry, inputs.sigmaAnnual, inputs.tenorSeconds);
  const fairValueUsdc = Math.floor(fvUsd * 1e6);
  const entryValueUsdc = Math.floor(geometry.entryValueUsd * 1e6);
  const effectiveMarkup = Math.max(inputs.markupFloor, inputs.ivRvRatio);
  const feeDiscountUsdc = computeFeeDiscount(
    entryValueUsdc,
    inputs.expectedDailyFee,
    inputs.feeSplitRate,
    inputs.tenorSeconds / 86_400,
  );
  const premiumUsdc = computePremium(
    fairValueUsdc,
    effectiveMarkup,
    feeDiscountUsdc,
    inputs.premiumFloorUsdc,
  );
  return {
    premiumUsdc,
    fairValueUsdc,
    effectiveMarkup,
    feeDiscountUsdc,
    capDownUsdc: Math.ceil(geometry.capDownUsd * 1e6),
    capUpUsdc: Math.ceil(geometry.capUpUsd * 1e6),
    entryValueUsdc,
  };
}
