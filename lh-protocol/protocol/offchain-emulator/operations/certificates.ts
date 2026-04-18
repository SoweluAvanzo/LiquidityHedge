/**
 * Certificate operations: buy and settle.
 * Exact port of certificates/instructions.rs logic.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  CertificateState,
  CertStatus,
  PositionStatus,
  BuyCertParams,
  BuyCertResult,
  SettleResult,
  REGIME_MAX_AGE_S,
} from "../../types";
import { StateStore } from "../state/store";
import { computeQuote } from "./pricing";
import { verifyIncomingTransfer, transferFromVault } from "../chain/token-ops";
import { AuditLogger } from "../audit/logger";
import { WHIRLPOOL_ADDRESS } from "../../../clients/cli/config";
import {
  estimateTokenAmounts,
  positionValueUsd,
} from "../../../clients/cli/position-value";
import {
  tickToSqrtPriceX64,
  priceToSqrtPriceX64,
} from "../../../clients/cli/whirlpool-ix";

/**
 * Buy a hedge certificate. Caller must have transferred premium USDC
 * to vault and provide the tx signature.
 *
 * Logic mirrors certificates/instructions.rs:handle_buy_certificate (lines 84-188).
 */
export async function buyCertificate(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  buyer: Keypair,
  params: BuyCertParams,
  premiumTxSignature: string
): Promise<BuyCertResult> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const mintStr = params.positionMint.toBase58();

  // Position checks
  const pos = store.getPosition(mintStr);
  if (!pos) throw new Error(`Position not found: ${mintStr}`);
  if (pos.owner !== buyer.publicKey.toBase58()) throw new Error("Unauthorized");
  if (pos.status !== PositionStatus.LOCKED) throw new Error("Position not locked");
  if (pos.protectedBy !== null) throw new Error("Already protected");

  // Template check
  const template = store.getTemplate(params.templateId);
  if (!template) throw new Error(`Template not found: ${params.templateId}`);
  if (!template.active) throw new Error("Template inactive");

  // ── Auto-compute barrier = lower tick of position (barrier = 1 - width) ──
  if (!params.lowerBarrierE6 || params.lowerBarrierE6 <= 0) {
    // Barrier aligns with the position's lower tick price
    const barrierPct = 1 - template.widthBps / 10_000;
    params.lowerBarrierE6 = Math.floor(pos.p0PriceE6 * barrierPct);
  }
  if (params.lowerBarrierE6 <= 0) throw new Error("InvalidBarrier");
  if (params.notionalUsdc <= 0) throw new Error("InvalidNotional");

  // ── Auto-compute natural cap = V(S₀) − V(B) if not specified ──
  if (!params.capUsdc || params.capUsdc <= 0) {
    const lowerSqrt = tickToSqrtPriceX64(pos.lowerTick);
    const upperSqrt = tickToSqrtPriceX64(pos.upperTick);
    const entrySqrt = priceToSqrtPriceX64(pos.p0PriceE6 / 1e6);
    const barrierSqrt = priceToSqrtPriceX64(params.lowerBarrierE6 / 1e6);
    const entryAmounts = estimateTokenAmounts(
      BigInt(pos.liquidity), entrySqrt, lowerSqrt, upperSqrt
    );
    const barrierAmounts = estimateTokenAmounts(
      BigInt(pos.liquidity), barrierSqrt, lowerSqrt, upperSqrt
    );
    const entryValue = positionValueUsd(
      entryAmounts.amountA, entryAmounts.amountB, pos.p0PriceE6 / 1e6
    );
    const barrierValue = positionValueUsd(
      barrierAmounts.amountA, barrierAmounts.amountB, params.lowerBarrierE6 / 1e6
    );
    params.capUsdc = Math.max(1, Math.floor((entryValue - barrierValue) * 1e6));
  }

  // Regime freshness check (900 seconds)
  const regime = store.getRegime();
  if (!regime) throw new Error("Regime not initialized");
  const now = Math.floor(Date.now() / 1000);
  if (now - regime.updatedTs > REGIME_MAX_AGE_S) {
    throw new Error(
      `StaleRegime: age=${now - regime.updatedTs}s, max=${REGIME_MAX_AGE_S}s`
    );
  }

  // Compute quote (same formula as on-chain)
  const quote = computeQuote(params.capUsdc, template, pool, regime);

  // Anti-replay
  if (store.isTxProcessed(premiumTxSignature)) {
    throw new Error("Premium transaction already processed");
  }

  // Verify premium transfer on-chain
  const verified = await verifyIncomingTransfer(
    connection,
    premiumTxSignature,
    buyer.publicKey,
    new PublicKey(pool.usdcVault),
    quote.premiumUsdc,
    new PublicKey(pool.usdcMint)
  );
  if (!verified) {
    throw new Error("Premium transfer verification failed");
  }

  // Compute expiry
  const expiryTs = now + template.tenorSeconds;

  // ── Protocol fee: 1.5% of premium to treasury ──
  const protocolFeeBps = pool.protocolFeeBps ?? 150;
  const protocolFee = Math.floor((quote.premiumUsdc * protocolFeeBps) / 10_000);
  const premiumAfterFee = quote.premiumUsdc - protocolFee;

  // v2: Split remaining premium into upfront + deferred
  const upfrontBps = pool.premiumUpfrontBps ?? 10_000;
  const premiumUpfrontUsdc = Math.floor(
    (premiumAfterFee * upfrontBps) / 10_000
  );
  const premiumDeferredUsdc = premiumAfterFee - premiumUpfrontUsdc;

  // Update pool state: only upfront portion (after protocol fee) goes to reserves
  store.updatePool((p) => {
    p.activeCapUsdc += quote.capUsdc;
    p.reservesUsdc += premiumUpfrontUsdc;
    p.protocolFeesCollected = (p.protocolFeesCollected ?? 0) + protocolFee;
  });

  // v2: Create premium escrow for deferred portion (if any)
  if (premiumDeferredUsdc > 0) {
    store.addPremiumEscrow({
      rtOwner: "", // assigned when RT is matched
      certPositionMint: mintStr,
      deferredAmountUsdc: premiumDeferredUsdc,
      accruedAmountUsdc: 0,
      depositTs: now,
      expiryTs,
      released: false,
    });
  }

  // Create certificate
  const cert: CertificateState = {
    owner: buyer.publicKey.toBase58(),
    positionMint: mintStr,
    pool: "pool", // single pool in PoC
    templateId: params.templateId,
    premiumUsdc: quote.premiumUsdc,
    capUsdc: quote.capUsdc,
    lowerBarrierE6: params.lowerBarrierE6,
    notionalUsdc: params.notionalUsdc,
    expiryTs,
    state: CertStatus.ACTIVE,
    nftMint: "offchain-cert-" + mintStr.slice(0, 8),
    // v2 fields
    premiumUpfrontUsdc,
    premiumDeferredUsdc,
    rtPositionMint: null,
    feeShareBps: 0,
  };
  store.addCertificate(cert);

  // Mark position as protected
  store.updatePosition(mintStr, (p) => {
    p.protectedBy = mintStr;
  });

  store.markTxProcessed(premiumTxSignature);

  logger.logOperation(
    "buyCertificate",
    {
      buyer: buyer.publicKey.toBase58(),
      positionMint: mintStr,
      premiumUsdc: quote.premiumUsdc,
      premiumUpfrontUsdc,
      premiumDeferredUsdc,
      capUsdc: quote.capUsdc,
      lowerBarrierE6: params.lowerBarrierE6,
      expiryTs,
    },
    store.getVersion(),
    "success",
    premiumTxSignature
  );

  return {
    premiumUsdc: quote.premiumUsdc,
    capUsdc: quote.capUsdc,
    expiryTs,
    premiumUpfrontUsdc,
    premiumDeferredUsdc,
  };
}

/**
 * Settle a certificate at/after expiry.
 *
 * Reads real Pyth price, computes proportional payout, transfers USDC if due.
 * Logic mirrors certificates/instructions.rs:handle_settle_certificate (lines 240-342).
 */
export async function settleCertificate(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  settler: Keypair,
  positionMint: PublicKey
): Promise<SettleResult> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const mintStr = positionMint.toBase58();
  const cert = store.getCertificate(mintStr);
  if (!cert) throw new Error(`Certificate not found: ${mintStr}`);
  if (cert.state !== CertStatus.ACTIVE) throw new Error("NotActive");

  const now = Math.floor(Date.now() / 1000);
  if (now < cert.expiryTs) {
    throw new Error(`TooEarly: ${cert.expiryTs - now}s remaining`);
  }

  // Read settlement price directly from the Orca Whirlpool pool.
  // This is the exact price that determines the LP's position composition —
  // using the same source for payout as for position value ensures perfect alignment.
  // No oracle dependency, no confidence interval, no staleness risk.
  const {
    decodeWhirlpoolAccount,
    sqrtPriceX64ToPrice,
  } = await import("../../../clients/cli/whirlpool-ix");
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found for settlement");
  const wpData = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));
  const settlementPriceUsd = sqrtPriceX64ToPrice(wpData.sqrtPrice);
  const settlementPriceE6 = Math.floor(settlementPriceUsd * 1_000_000);

  // No confidence adjustment — Whirlpool price is the ground truth
  const conservativePriceE6 = settlementPriceE6;

  // ── Corridor payout using actual CL position value ──────────────────
  // Payout = actual position loss within [barrier, entry], capped at barrier-level loss below barrier.
  const pos = store.getPosition(mintStr);
  if (!pos) throw new Error(`Position not found: ${mintStr}`);
  const liquidity = BigInt(pos.liquidity);
  const sqrtPriceLower = tickToSqrtPriceX64(pos.lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(pos.upperTick);
  const entryPriceE6 = pos.p0PriceE6;

  // Entry value (at p0)
  const sqrtPriceEntry = priceToSqrtPriceX64(entryPriceE6 / 1e6);
  const entryAmounts = estimateTokenAmounts(liquidity, sqrtPriceEntry, sqrtPriceLower, sqrtPriceUpper);
  const entryValue = positionValueUsd(entryAmounts.amountA, entryAmounts.amountB, entryPriceE6 / 1e6);

  let payout = 0;
  if (conservativePriceE6 < entryPriceE6) {
    // Price dropped — compute CL position loss
    const effectivePriceE6 = Math.max(conservativePriceE6, cert.lowerBarrierE6);
    const effectivePriceUsd = effectivePriceE6 / 1e6;
    const sqrtPriceSettle = priceToSqrtPriceX64(effectivePriceUsd);
    const settleAmounts = estimateTokenAmounts(liquidity, sqrtPriceSettle, sqrtPriceLower, sqrtPriceUpper);
    const settleValue = positionValueUsd(settleAmounts.amountA, settleAmounts.amountB, effectivePriceUsd);

    const positionLossUsd = Math.max(0, entryValue - settleValue);
    const positionLossUsdc = Math.floor(positionLossUsd * 1e6);
    payout = Math.min(positionLossUsdc, cert.capUsdc);
  }
  // If conservativePriceE6 >= entryPriceE6: no loss, payout = 0
  // If conservativePriceE6 < barrier: effectivePrice is clamped to barrier, so payout is capped at barrier-level loss

  // v2: Collect Orca trading fees and compute fee share for RT
  let collectedFeesA = 0;
  let collectedFeesB = 0;
  const feeShareBps = cert.feeShareBps ?? 0;
  // Fee collection happens at settlement in v2 (Phase 5 integration)
  // For now, fees are collected during position close in cleanup.
  // The fee share is computed and stored on the certificate.
  store.updateCertificate(mintStr, (c) => {
    c.collectedFeesA = collectedFeesA;
    c.collectedFeesB = collectedFeesB;
  });

  // Transfer payout if due
  let txSig: string | undefined;
  if (payout > 0) {
    if (pool.reservesUsdc < payout) {
      throw new Error("InsufficientReserves");
    }
    txSig = await transferFromVault(
      connection,
      vaultKeypair,
      new PublicKey(pool.usdcMint),
      new PublicKey(cert.owner),
      payout
    );
  }

  // v2: Release deferred premium to pool reserves at settlement
  let deferredPremiumReleased = 0;
  const escrow = store.getPremiumEscrow(mintStr);
  if (escrow && !escrow.released) {
    deferredPremiumReleased = escrow.deferredAmountUsdc;
    store.updatePremiumEscrow(mintStr, (e) => {
      e.accruedAmountUsdc = e.deferredAmountUsdc;
      e.released = true;
    });
  }

  // Update pool state
  store.updatePool((p) => {
    if (payout > 0) p.reservesUsdc -= payout;
    p.reservesUsdc += deferredPremiumReleased; // deferred premium now enters reserves
    p.activeCapUsdc -= cert.capUsdc;
  });

  // Update certificate state
  const newState = payout > 0 ? CertStatus.SETTLED : CertStatus.EXPIRED;
  store.updateCertificate(mintStr, (c) => {
    c.state = newState;
  });

  // Release position protection
  store.updatePosition(mintStr, (p) => {
    p.protectedBy = null;
  });

  logger.logOperation(
    "settleCertificate",
    {
      positionMint: mintStr,
      settlementPriceE6,
      conservativePriceE6,
      payout,
      deferredPremiumReleased,
      state: newState,
    },
    store.getVersion(),
    "success",
    txSig
  );

  return {
    payout,
    state: newState,
    settlementPriceE6,
    conservativePriceE6,
    deferredPremiumReleased,
  };
}
