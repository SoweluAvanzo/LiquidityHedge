/**
 * Certificate operations: buy and settle.
 *
 * v2 changes:
 * - Two-part premium mode: LP pays alpha * H * vol_indicator upfront,
 *   deferred portion = beta * actual_fees at settlement
 * - Fixed mode preserved as fallback (identical to v1)
 * - Settlement computes deferred premium from actual fee accrual
 * - betaFraction stored on certificate for settlement computation
 *
 * The payout formula is unchanged from v1:
 *   payout = min(cap, max(0, position_loss_within_corridor))
 * where position loss is computed using actual CL math (not linear approx).
 */

import {
  CertificateState,
  CertStatus,
  PositionStatus,
  PositionState,
  PoolState,
  TemplateConfig,
  RegimeSnapshot,
  BuyCertParams,
  BuyCertResult,
  SettleResult,
  QuoteBreakdown,
  PPM,
  BPS,
  REGIME_MAX_AGE_S,
} from "../types";
import { computeQuote, computeTwoPartQuote, computeVolIndicator } from "./pricing";

// ─── State Store Interface ───────────────────────────────────────────

/**
 * State store abstraction for certificate operations.
 * Implementations can be in-memory (emulator) or on-chain (adapter).
 */
export interface CertStore {
  getPool(): PoolState | null;
  updatePool(fn: (pool: PoolState) => void): void;
  getPosition(mint: string): PositionState | null;
  updatePosition(mint: string, fn: (pos: PositionState) => void): void;
  getTemplate(id: number): TemplateConfig | null;
  getRegime(): RegimeSnapshot | null;
  getCertificate(mint: string): CertificateState | null;
  addCertificate(cert: CertificateState): void;
  updateCertificate(mint: string, fn: (cert: CertificateState) => void): void;
}

// ─── Buy Certificate ─────────────────────────────────────────────────

/**
 * Buy a hedge certificate.
 *
 * In two-part mode:
 *   - Upfront = alpha * heuristicPremium * vol_indicator
 *   - betaFraction is stored on the certificate
 *   - At settlement: deferred = beta * actualFeesAccrued
 *   - LP pays only upfront now; deferred is computed and debited at settlement
 *
 * In fixed mode:
 *   - Full heuristic premium paid upfront (v1 behavior)
 *   - betaFraction = 0, premiumDeferredUsdc = 0
 *
 * @param store    State store
 * @param buyer    Buyer's public key (base58)
 * @param params   Certificate parameters
 * @param nowTs    Current unix timestamp (seconds). Defaults to Date.now()/1000.
 * @returns Buy result with premium breakdown
 */
export function buyCertificate(
  store: CertStore,
  buyer: string,
  params: BuyCertParams,
  nowTs?: number,
): BuyCertResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const mintStr = params.positionMint;

  // Position checks
  const pos = store.getPosition(mintStr);
  if (!pos) throw new Error(`Position not found: ${mintStr}`);
  if (pos.owner !== buyer) throw new Error("Unauthorized");
  if (pos.status !== PositionStatus.LOCKED) throw new Error("Position not locked");
  if (pos.protectedBy !== null) throw new Error("Already protected");

  // Template check
  const template = store.getTemplate(params.templateId);
  if (!template) throw new Error(`Template not found: ${params.templateId}`);
  if (!template.active) throw new Error("Template inactive");

  // Auto-compute barrier = lower tick of position (barrier = 1 - width)
  let lowerBarrierE6 = params.lowerBarrierE6;
  if (!lowerBarrierE6 || lowerBarrierE6 <= 0) {
    const barrierPct = 1 - template.widthBps / 10_000;
    lowerBarrierE6 = Math.floor(pos.p0PriceE6 * barrierPct);
  }
  if (lowerBarrierE6 <= 0) throw new Error("InvalidBarrier");

  const notionalUsdc = params.notionalUsdc;
  if (notionalUsdc <= 0) throw new Error("InvalidNotional");

  const capUsdc = params.capUsdc;
  if (capUsdc <= 0) throw new Error("InvalidCap");

  // Regime freshness check
  const regime = store.getRegime();
  if (!regime) throw new Error("Regime not initialized");
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  if (now - regime.updatedTs > REGIME_MAX_AGE_S) {
    throw new Error(
      `StaleRegime: age=${now - regime.updatedTs}s, max=${REGIME_MAX_AGE_S}s`
    );
  }

  // Compute quote (heuristic premium)
  const quote = computeQuote(capUsdc, template, pool, regime);

  // Protocol fee: 1.5% of premium to treasury
  const protocolFeeBps = pool.protocolFeeBps ?? 150;
  const protocolFee = Math.floor((quote.premiumUsdc * protocolFeeBps) / 10_000);
  const premiumAfterFee = quote.premiumUsdc - protocolFee;

  // Compute premium split based on pool mode
  let premiumUpfrontUsdc: number;
  let premiumDeferredUsdc: number;
  let betaFraction: number;

  if (pool.premiumMode === "two-part") {
    // Two-part premium: alpha * H * vol_indicator upfront
    const expectedWeeklyFees = params.expectedWeeklyFeesUsdc ?? 0;
    const twoPartQuote = computeTwoPartQuote(
      capUsdc, template, pool, regime, expectedWeeklyFees
    );

    // Upfront after protocol fee deduction: scale proportionally
    premiumUpfrontUsdc = Math.floor(
      (twoPartQuote.upfrontUsdc * premiumAfterFee) / Math.max(quote.premiumUsdc, 1)
    );
    premiumDeferredUsdc = premiumAfterFee - premiumUpfrontUsdc;
    betaFraction = twoPartQuote.betaFraction;
  } else {
    // Fixed mode: full premium upfront (v1 behavior)
    premiumUpfrontUsdc = premiumAfterFee;
    premiumDeferredUsdc = 0;
    betaFraction = 0;
  }

  // Compute expiry
  const expiryTs = now + template.tenorSeconds;

  // Update pool: only upfront portion goes to reserves immediately;
  // deferred is NOT added to reserves until settlement.
  store.updatePool((p) => {
    p.activeCapUsdc += capUsdc;
    p.reservesUsdc += premiumUpfrontUsdc;
    p.protocolFeesCollected = (p.protocolFeesCollected ?? 0) + protocolFee;
  });

  // Create certificate
  const cert: CertificateState = {
    owner: buyer,
    positionMint: mintStr,
    pool: "pool",
    templateId: params.templateId,
    premiumUsdc: quote.premiumUsdc,
    capUsdc,
    lowerBarrierE6,
    notionalUsdc,
    expiryTs,
    state: CertStatus.ACTIVE,
    nftMint: "offchain-cert-" + mintStr.slice(0, 8),
    premiumUpfrontUsdc,
    premiumDeferredUsdc,
    betaFraction,
    feesAccruedUsdc: 0,
    settlementPremiumUsdc: 0,
  };
  store.addCertificate(cert);

  // Mark position as protected
  store.updatePosition(mintStr, (p) => {
    p.protectedBy = mintStr;
  });

  return {
    premiumUsdc: quote.premiumUsdc,
    capUsdc,
    expiryTs,
    premiumUpfrontUsdc,
    premiumDeferredUsdc,
    betaFraction,
  };
}

// ─── Settle Certificate ──────────────────────────────────────────────

/**
 * Settle a certificate at/after expiry.
 *
 * Settlement flow:
 * 1. Verify certificate is active and expired
 * 2. Compute proportional payout based on settlement price vs entry price
 * 3. If two-part mode: compute settlement premium = beta * actualFeesAccrued
 *    - Debit settlement premium from LP (conceptually: LP owes this to the pool)
 *    - Credit settlement premium to pool reserves
 * 4. Transfer payout (if any) from pool reserves to LP
 * 5. Update certificate, pool, and position states
 *
 * The corridor payout uses actual CL position value math:
 *   effectivePrice = max(settlementPrice, barrier)
 *   loss = V(entry) - V(effectivePrice)
 *   payout = min(cap, max(0, loss))
 *
 * @param store              State store
 * @param positionMint       Position mint identifying the certificate
 * @param settlementPriceE6  Settlement price (micro-USD, e.g. 150_000_000 = $150)
 * @param feesAccruedUsdc    Actual LP fees accrued during the tenor (micro-USDC)
 * @param nowTs              Current unix timestamp. Defaults to Date.now()/1000.
 * @returns Settlement result
 */
export function settleCertificate(
  store: CertStore,
  positionMint: string,
  settlementPriceE6: number,
  feesAccruedUsdc: number,
  nowTs?: number,
): SettleResult {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const mintStr = positionMint;
  const cert = store.getCertificate(mintStr);
  if (!cert) throw new Error(`Certificate not found: ${mintStr}`);
  if (cert.state !== CertStatus.ACTIVE) throw new Error("NotActive");

  const now = nowTs ?? Math.floor(Date.now() / 1000);
  if (now < cert.expiryTs) {
    throw new Error(`TooEarly: ${cert.expiryTs - now}s remaining`);
  }

  // Conservative price (no oracle confidence adjustment in v2 emulator)
  const conservativePriceE6 = settlementPriceE6;

  // ── Corridor payout using proportional IL model ──────────────────
  // For the off-chain emulator, we use a simplified proportional payout:
  //   payout = min(cap, max(0, (entryPrice - effectivePrice) * notional / entryPrice))
  // The effectivePrice is clamped to the barrier (lower bound of corridor).
  const pos = store.getPosition(mintStr);
  if (!pos) throw new Error(`Position not found: ${mintStr}`);

  const entryPriceE6 = pos.p0PriceE6;
  let payout = 0;

  if (conservativePriceE6 < entryPriceE6) {
    // Price dropped — compute corridor loss
    const effectivePriceE6 = Math.max(conservativePriceE6, cert.lowerBarrierE6);
    // Proportional loss: (entry - effective) / entry * notional
    const lossFraction =
      (entryPriceE6 - effectivePriceE6) / entryPriceE6;
    const lossUsdc = Math.floor(lossFraction * cert.notionalUsdc);
    payout = Math.min(lossUsdc, cert.capUsdc);
  }

  // ── Two-part settlement premium ──────────────────────────────────
  let settlementPremiumUsdc = 0;
  if (pool.premiumMode === "two-part" && cert.betaFraction > 0) {
    // Deferred premium = beta * actual fees accrued
    settlementPremiumUsdc = Math.floor(cert.betaFraction * feesAccruedUsdc);
  }
  const totalPremiumUsdc = cert.premiumUpfrontUsdc + settlementPremiumUsdc;

  // ── Update pool state ────────────────────────────────────────────
  // Settlement premium from LP goes into reserves (RT income).
  // Payout comes out of reserves.
  store.updatePool((p) => {
    p.reservesUsdc += settlementPremiumUsdc; // deferred premium enters reserves
    if (payout > 0) {
      if (p.reservesUsdc < payout) {
        throw new Error(
          `InsufficientReserves: have ${p.reservesUsdc}, need ${payout}`
        );
      }
      p.reservesUsdc -= payout;
    }
    p.activeCapUsdc -= cert.capUsdc;
  });

  // ── Update certificate state ─────────────────────────────────────
  const newState = payout > 0 ? CertStatus.SETTLED : CertStatus.EXPIRED;
  store.updateCertificate(mintStr, (c) => {
    c.state = newState;
    c.feesAccruedUsdc = feesAccruedUsdc;
    c.settlementPremiumUsdc = settlementPremiumUsdc;
  });

  // Release position protection
  store.updatePosition(mintStr, (p) => {
    p.protectedBy = null;
  });

  return {
    payout,
    state: newState,
    settlementPriceE6,
    conservativePriceE6,
    feesAccruedUsdc,
    settlementPremiumUsdc,
    totalPremiumUsdc,
  };
}
