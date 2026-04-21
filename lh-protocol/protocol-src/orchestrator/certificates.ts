/**
 * Liquidity Hedge Protocol — Certificate Lifecycle
 *
 * Manages the two main certificate operations:
 *
 *   buyCertificate:    LP purchases Liquidity Hedge protection
 *   settleCertificate: Anyone settles at/after expiry (permissionless)
 *
 * The Liquidity Hedge payoff (signed swap on V(·)):
 *   Π(S_T) = V(S_0) - V(clamp(S_T, p_l, p_u))
 *
 * Positive ⇒ RT pays LP (downside realized within the active range).
 * Negative ⇒ LP pays RT (upside realized within the active range), settled
 *            physically from the escrowed position's proceeds, which
 *            always cover the owed amount.
 */

import {
  BPS,
  PoolState,
  PositionState,
  PositionStatus,
  CertificateState,
  CertificateStatus,
  RegimeSnapshot,
  TemplateConfig,
  REGIME_MAX_AGE_S,
} from "../types";
import { StateStore } from "../event-audit/store";
import { computeQuote, computeFeeDiscount, QuoteParams } from "../pricing-engine/pricing";
import { availableHeadroom } from "../pool-manager/pool";
import { isRegimeFresh } from "../risk-analyser/regime";
import { computeBarrierFromWidth } from "../config/templates";
import {
  clPositionValue,
  naturalCap,
  lhPayoff,
} from "../pricing-engine/position-value";

// ---------------------------------------------------------------------------
// Buy certificate
// ---------------------------------------------------------------------------

export interface BuyCertParams {
  /** Position mint to protect */
  positionMint: string;
  /** Template ID for the product */
  templateId: number;
  /** Current timestamp (optional, defaults to now) */
  nowTs?: number;
}

export interface BuyCertResult {
  premiumUsdc: number;
  capUsdc: number;
  barrierE6: number;
  fairValueUsdc: number;
  effectiveMarkup: number;
  feeDiscountUsdc: number;
  protocolFeeUsdc: number;
  expiryTs: number;
}

/**
 * Purchase a Liquidity Hedge certificate for a locked CL position.
 *
 * Steps:
 *   1. Validate position is locked and unprotected
 *   2. Validate regime is fresh
 *   3. Derive barrier from position width: B = S_0 * (1 - widthBps/BPS)
 *   4. Compute natural cap: Cap = V(S_0) - V(B)
 *   5. Compute premium via canonical formula
 *   6. Deduct protocol fee from premium
 *   7. Flow (premium - protocolFee) into pool reserves
 *   8. Increase pool.activeCapUsdc
 *   9. Set position.protectedBy
 *   10. Create certificate record
 *
 * @param store  - State store
 * @param buyer  - LP wallet address
 * @param params - Certificate purchase parameters
 * @returns Purchase result with full breakdown
 */
export function buyCertificate(
  store: StateStore,
  buyer: string,
  params: BuyCertParams,
): BuyCertResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const position = store.getPosition(params.positionMint);
  if (!position) throw new Error(`Position ${params.positionMint} not found`);
  if (position.status !== PositionStatus.Locked) {
    throw new Error("Position must be locked");
  }
  if (position.protectedBy) {
    throw new Error("Position already protected by another certificate");
  }

  const template = store.getTemplate(params.templateId);
  if (!template) throw new Error(`Template ${params.templateId} not found`);

  const regime = store.getRegime();
  if (!regime) throw new Error("Regime not initialized");

  const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000);
  if (!isRegimeFresh(regime, nowTs)) {
    throw new Error("Regime snapshot is stale");
  }

  // Derive barrier from width (barrier = lower bound of CL range)
  const barrierE6 = computeBarrierFromWidth(
    position.entryPriceE6,
    template.widthBps,
  );

  // Compute position value at entry and barrier for natural cap
  const S0 = position.entryPriceE6 / 1_000_000;
  const pL = barrierE6 / 1_000_000;
  const pU = (position.entryPriceE6 * (1 + template.widthBps / BPS)) / 1_000_000;
  const L = Number(position.liquidity);

  const cap = naturalCap(S0, L, pL, pU);
  const capUsdc = Math.floor(cap * 1_000_000);
  if (capUsdc <= 0) throw new Error("Natural cap is zero or negative");

  // Check utilization headroom
  if (capUsdc > availableHeadroom(pool)) {
    throw new Error("Insufficient pool headroom for this certificate");
  }

  // Compute quote
  const quoteParams: QuoteParams = {
    entryPriceE6: position.entryPriceE6,
    notionalUsdc: position.entryValueE6,
    liquidity: L,
    pL,
    pU,
  };

  const quote = computeQuote(quoteParams, template, pool, regime);
  if (!quote) throw new Error("Quote computation failed (utilization exceeded)");

  // Protocol fee
  const protocolFeeUsdc = Math.floor(
    (quote.premiumUsdc * pool.protocolFeeBps) / BPS,
  );
  const premiumToPool = quote.premiumUsdc - protocolFeeUsdc;

  // Expected weekly fees (for record-keeping)
  const tenorDays = template.tenorSeconds / 86_400;
  const expectedWeeklyFeesUsdc = Math.floor(
    position.entryValueE6 * pool.expectedDailyFee * tenorDays,
  );

  // Create certificate
  const expiryTs = nowTs + template.tenorSeconds;
  const certMint = `cert-${params.positionMint}-${nowTs}`;

  const cert: CertificateState = {
    positionMint: params.positionMint,
    buyer,
    pool: "pool",
    templateId: params.templateId,
    entryPriceE6: position.entryPriceE6,
    lowerBarrierE6: barrierE6,
    notionalUsdc: position.entryValueE6,
    capUsdc,
    premiumUsdc: quote.premiumUsdc,
    protocolFeeUsdc,
    feeSplitRate: pool.feeSplitRate,
    expectedWeeklyFeesUsdc,
    purchaseTs: nowTs,
    expiryTs,
    state: CertificateStatus.Active,
    bump: 255,
  };

  // Update state
  store.addCertificate(cert);
  store.updatePool((p) => {
    p.reservesUsdc += premiumToPool;
    p.activeCapUsdc += capUsdc;
  });
  store.updatePosition(params.positionMint, (pos) => {
    pos.protectedBy = certMint;
  });

  return {
    premiumUsdc: quote.premiumUsdc,
    capUsdc,
    barrierE6,
    fairValueUsdc: quote.fairValueUsdc,
    effectiveMarkup: quote.effectiveMarkup,
    feeDiscountUsdc: quote.feeDiscountUsdc,
    protocolFeeUsdc,
    expiryTs,
  };
}

// ---------------------------------------------------------------------------
// Settle certificate
// ---------------------------------------------------------------------------

export interface SettleResult {
  payoutUsdc: number;
  rtFeeIncomeUsdc: number;
  state: CertificateStatus;
  settlementPriceE6: number;
  feesAccruedUsdc: number;
}

/**
 * Settle a certificate at or after expiry.
 *
 * Settlement is permissionless — anyone can call it for protocol liveness.
 *
 * Payout is the signed Liquidity Hedge swap payoff:
 *   Π(S_T) = V(S_0) - V(clamp(S_T, p_l, p_u))
 *
 *   - S_T < p_l:          Π = +Cap_down (RT pays LP maximum)
 *   - p_l ≤ S_T ≤ S_0:    Π = V(S_0) - V(S_T)  (RT pays LP, exact IL)
 *   - S_0 ≤ S_T ≤ p_u:    Π = V(S_0) - V(S_T)  (LP pays RT, upside give-up)
 *   - S_T > p_u:          Π = -Cap_up (LP pays RT maximum)
 *
 * Fee split: rtFeeIncome = feeSplitRate * feesAccruedUsdc
 *
 * State updates:
 *   - Pool reserves: -= payout  (negative payout ⇒ pool gains)
 *                   += rtFeeIncome
 *   - Pool activeCapUsdc: -= capUsdc (releases Cap_down reservation)
 *   - Position.protectedBy: cleared
 *   - Certificate state: SETTLED on any non-zero payout, EXPIRED only
 *     at the measure-zero event S_T = S_0 exactly.
 *
 * @param store              - State store
 * @param positionMint       - Position mint of the certificate to settle
 * @param settlementPriceE6  - Settlement price (micro-USD, from oracle)
 * @param feesAccruedUsdc    - LP trading fees accrued during tenor (micro-USDC)
 * @param nowTs              - Current timestamp
 * @returns Settlement result (payoutUsdc is signed: + ⇒ RT→LP, − ⇒ LP→RT)
 */
export function settleCertificate(
  store: StateStore,
  positionMint: string,
  settlementPriceE6: number,
  feesAccruedUsdc: number,
  nowTs?: number,
): SettleResult {
  const cert = store.getCertificate(positionMint);
  if (!cert) throw new Error(`Certificate for ${positionMint} not found`);
  if (cert.state !== CertificateStatus.Active) {
    throw new Error(`Certificate is not active (state=${cert.state})`);
  }

  const now = nowTs ?? Math.floor(Date.now() / 1000);
  if (now < cert.expiryTs) {
    throw new Error(
      `Certificate not yet expired: now=${now}, expiry=${cert.expiryTs}`,
    );
  }

  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const position = store.getPosition(positionMint);
  if (!position) throw new Error(`Position ${positionMint} not found`);

  const template = store.getTemplate(cert.templateId);
  if (!template) throw new Error(`Template ${cert.templateId} not found`);

  // Signed Liquidity Hedge payoff
  const S0 = cert.entryPriceE6 / 1_000_000;
  const ST = settlementPriceE6 / 1_000_000;
  const pL = cert.lowerBarrierE6 / 1_000_000;
  const pU = S0 * (1 + template.widthBps / BPS);
  const L = Number(position.liquidity);

  const payoutUsd = lhPayoff(ST, S0, L, pL, pU);
  const payoutUsdc = Math.trunc(payoutUsd * 1_000_000);

  // Fee split: RT receives y% of LP's actual trading fees
  const rtFeeIncomeUsdc = Math.floor(cert.feeSplitRate * feesAccruedUsdc);

  // Any non-zero cash flow is a real settlement under the swap
  const finalState =
    payoutUsdc !== 0 ? CertificateStatus.Settled : CertificateStatus.Expired;

  store.updateCertificate(positionMint, (c) => {
    c.state = finalState;
    c.settlementPriceE6 = settlementPriceE6;
    c.payoutUsdc = payoutUsdc;
    c.rtFeeIncomeUsdc = rtFeeIncomeUsdc;
  });

  // Pool accounting handles signed payout transparently: negative
  // payoutUsdc (LP owes RT) becomes a positive addition to reserves.
  store.updatePool((p) => {
    p.reservesUsdc -= payoutUsdc;
    p.reservesUsdc += rtFeeIncomeUsdc;
    p.activeCapUsdc -= cert.capUsdc;
  });

  store.updatePosition(positionMint, (pos) => {
    pos.protectedBy = null;
  });

  return {
    payoutUsdc,
    rtFeeIncomeUsdc,
    state: finalState,
    settlementPriceE6,
    feesAccruedUsdc,
  };
}
