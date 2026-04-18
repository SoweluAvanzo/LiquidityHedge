/**
 * Certificate operations: buy and settle.
 *
 * v3 changes from v2:
 * - Removed two-part premium (alpha/beta split)
 * - Added coverRatio: LP chooses how much of the natural cap to hedge (0.25-1.00)
 * - Premium = FV * effectiveMarkup * coverRatio - feeSplitRate * E[weeklyFees]
 * - Settlement payout is scaled by coverRatio
 * - Fee split: RT receives feeSplitRate% of actual LP fees at settlement
 * - Barrier derived from template.barrierDepthBps (not fixed to width)
 *
 * The corridor payout formula is unchanged:
 *   fullPayout = min(naturalCap, max(0, V(S0) - V(Seff)))
 *   scaledPayout = fullPayout * coverRatio
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
  PPM,
  BPS,
  REGIME_MAX_AGE_S,
  DEFAULT_COVER_RATIO,
} from "../types";
import {
  computeQuote,
  computeV3Premium,
  computeV3Payout,
  computeRtFeeIncome,
} from "./pricing";

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
 * Buy a hedge certificate with cover ratio scaling.
 *
 * v3 flow:
 *   1. Validate position, template, regime freshness
 *   2. Compute barrier from template.barrierDepthBps
 *   3. Scaled cap = naturalCap * coverRatio
 *   4. Premium = FairValue(scaledCap) * effectiveMarkup
 *   5. Protocol fee deducted (1.5% default)
 *   6. Remainder goes to pool reserves (RT income)
 *   7. ActiveCap increases by scaledCap
 *
 * @param store    State store
 * @param buyer    Buyer's public key (base58)
 * @param params   Certificate parameters (including coverRatio)
 * @param nowTs    Current unix timestamp (seconds)
 * @returns Buy result with premium and cover ratio
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

  // Cover ratio: LP's choice, clamped to [0.25, 1.00]
  const coverRatio = Math.max(0.25, Math.min(1.0, params.coverRatio ?? DEFAULT_COVER_RATIO));

  // Barrier: derived from template.barrierDepthBps
  let lowerBarrierE6 = params.lowerBarrierE6;
  if (!lowerBarrierE6 || lowerBarrierE6 <= 0) {
    const barrierPct = 1 - template.barrierDepthBps / BPS;
    lowerBarrierE6 = Math.floor(pos.p0PriceE6 * barrierPct);
  }
  if (lowerBarrierE6 <= 0) throw new Error("InvalidBarrier");

  const notionalUsdc = params.notionalUsdc;
  if (notionalUsdc <= 0) throw new Error("InvalidNotional");

  const naturalCapUsdc = params.naturalCapUsdc;
  if (naturalCapUsdc <= 0) throw new Error("InvalidCap");

  // Scaled cap
  const capUsdc = Math.floor(naturalCapUsdc * coverRatio);

  // Regime freshness check
  const regime = store.getRegime();
  if (!regime) throw new Error("Regime not initialized");
  const now = nowTs ?? Math.floor(Date.now() / 1000);
  if (now - regime.updatedTs > REGIME_MAX_AGE_S) {
    throw new Error(
      `StaleRegime: age=${now - regime.updatedTs}s, max=${REGIME_MAX_AGE_S}s`
    );
  }

  // Compute quote via v3 formula (fair value + markup, before fee discount)
  const quote = computeQuote(naturalCapUsdc, template, pool, regime, coverRatio);

  // Apply fee-split premium discount:
  // E[weeklyFees] = notionalUsdc * expectedDailyFee * 7
  const expectedWeeklyFeesUsdc = Math.floor(
    notionalUsdc * (pool.expectedDailyFee ?? 0) * 7,
  );
  const premiumUsdc = computeV3Premium(
    quote.fairValueUsdc,
    quote.effectiveMarkup,
    coverRatio,
    pool.feeSplitRate ?? 0,
    expectedWeeklyFeesUsdc,
  );

  // Protocol fee: 1.5% of premium to treasury
  const protocolFeeBps = pool.protocolFeeBps ?? 150;
  const protocolFee = Math.floor((premiumUsdc * protocolFeeBps) / BPS);
  const premiumAfterFee = premiumUsdc - protocolFee;

  // Compute expiry
  const expiryTs = now + template.tenorSeconds;

  // Update pool: premium (after protocol fee) goes to reserves
  store.updatePool((p) => {
    p.activeCapUsdc += capUsdc;
    p.reservesUsdc += premiumAfterFee;
    p.protocolFeesCollected = (p.protocolFeesCollected ?? 0) + protocolFee;
  });

  // Create certificate
  const cert: CertificateState = {
    owner: buyer,
    positionMint: mintStr,
    pool: "pool",
    templateId: params.templateId,
    premiumUsdc,
    capUsdc,
    coverRatio,
    lowerBarrierE6,
    notionalUsdc,
    expiryTs,
    state: CertStatus.ACTIVE,
    nftMint: "offchain-cert-" + mintStr.slice(0, 8),
  };
  store.addCertificate(cert);

  // Mark position as protected
  store.updatePosition(mintStr, (p) => {
    p.protectedBy = mintStr;
  });

  return {
    premiumUsdc,
    capUsdc,
    coverRatio,
    effectiveMarkup: quote.effectiveMarkup,
    expiryTs,
  };
}

// ─── Settle Certificate ──────────────────────────────────────────────

/**
 * Settle a certificate at/after expiry.
 *
 * v3 settlement flow:
 *   1. Verify certificate is active and expired
 *   2. Compute full corridor payout (unscaled by cover ratio)
 *   3. Scale payout by cert.coverRatio
 *   4. Compute RT fee income: feeSplitRate * actualFees
 *   5. RT fee income flows INTO the pool (RT income from LP fee split)
 *   6. Payout flows OUT of the pool to LP
 *   7. Net RT impact: +premium +rtFeeIncome -payout
 *
 * The corridor payout uses proportional IL:
 *   effectivePrice = max(settlementPrice, barrier)
 *   loss = (entryPrice - effectivePrice) / entryPrice * notional
 *   fullPayout = min(naturalCap, max(0, loss))
 *   scaledPayout = fullPayout * coverRatio
 *
 * @param store               State store
 * @param positionMint        Position mint identifying the certificate
 * @param settlementPriceE6   Settlement price (micro-USD)
 * @param feesAccruedUsdc     Actual LP fees accrued during the tenor (micro-USDC)
 * @param nowTs               Current unix timestamp
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

  // Conservative price (no oracle confidence adjustment in emulator)
  const conservativePriceE6 = settlementPriceE6;

  // ── Full corridor payout (before cover ratio scaling) ────────────
  const pos = store.getPosition(mintStr);
  if (!pos) throw new Error(`Position not found: ${mintStr}`);

  const entryPriceE6 = pos.p0PriceE6;
  let fullPayout = 0;

  if (conservativePriceE6 < entryPriceE6) {
    // Price dropped -- compute corridor loss
    const effectivePriceE6 = Math.max(conservativePriceE6, cert.lowerBarrierE6);
    // Proportional loss: (entry - effective) / entry * notional
    const lossFraction = (entryPriceE6 - effectivePriceE6) / entryPriceE6;
    const lossUsdc = Math.floor(lossFraction * cert.notionalUsdc);
    // Natural cap = capUsdc / coverRatio (recover the unscaled cap)
    const naturalCap = cert.coverRatio > 0
      ? Math.floor(cert.capUsdc / cert.coverRatio)
      : cert.capUsdc;
    fullPayout = Math.min(lossUsdc, naturalCap);
  }

  // ── Scale payout by cover ratio ──────────────────────────────────
  const scaledPayout = computeV3Payout(fullPayout, cert.coverRatio);

  // ── RT fee income (fee split) ────────────────────────────────────
  const rtFeeIncome = computeRtFeeIncome(feesAccruedUsdc, pool.feeSplitRate);

  // ── Update pool state ────────────────────────────────────────────
  // RT fee income flows into reserves (RT's share of LP trading fees).
  // Payout flows out of reserves to LP.
  store.updatePool((p) => {
    p.reservesUsdc += rtFeeIncome;
    if (scaledPayout > 0) {
      if (p.reservesUsdc < scaledPayout) {
        throw new Error(
          `InsufficientReserves: have ${p.reservesUsdc}, need ${scaledPayout}`
        );
      }
      p.reservesUsdc -= scaledPayout;
    }
    p.activeCapUsdc -= cert.capUsdc;
  });

  // ── Update certificate state ─────────────────────────────────────
  const newState = scaledPayout > 0 ? CertStatus.SETTLED : CertStatus.EXPIRED;
  store.updateCertificate(mintStr, (c) => {
    c.state = newState;
  });

  // Release position protection
  store.updatePosition(mintStr, (p) => {
    p.protectedBy = null;
  });

  // Net LP receives: scaledPayout (the fee split is a separate flow to RT)
  const netLpPayout = scaledPayout;

  return {
    payout: scaledPayout,
    fullPayout,
    rtFeeIncome,
    netLpPayout,
    state: newState,
    settlementPriceE6,
    conservativePriceE6,
    feesAccruedUsdc,
  };
}
