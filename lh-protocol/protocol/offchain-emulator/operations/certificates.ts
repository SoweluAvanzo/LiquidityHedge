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
import { readPythPrice } from "../chain/pyth-reader";
import { verifyIncomingTransfer, transferFromVault } from "../chain/token-ops";
import { AuditLogger } from "../audit/logger";
import { PYTH_SOL_USD_FEED } from "../../../clients/cli/config";

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

  // Barrier and notional validation (from our hardening)
  if (params.lowerBarrierE6 <= 0) throw new Error("InvalidBarrier");
  if (params.notionalUsdc <= 0) throw new Error("InvalidNotional");

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

  // Update pool state (reserve exposure + add premium to reserves)
  store.updatePool((p) => {
    p.activeCapUsdc += quote.capUsdc;
    p.reservesUsdc += quote.premiumUsdc;
  });

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
    nftMint: "offchain-cert-" + mintStr.slice(0, 8), // no real NFT in emulator
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

  // Read Pyth price
  const pyth = await readPythPrice(connection, PYTH_SOL_USD_FEED);

  // Conservative downside: price - confidence (same as on-chain)
  const conservativePriceE6 = Math.max(0, pyth.priceE6 - pyth.confE6);

  // Proportional payout: min(cap, max(0, (barrier - price) * notional / barrier))
  let payout = 0;
  if (conservativePriceE6 < cert.lowerBarrierE6) {
    const deficit = cert.lowerBarrierE6 - conservativePriceE6;
    const rawPayout = Math.floor(
      (deficit * cert.notionalUsdc) / Math.max(cert.lowerBarrierE6, 1)
    );
    payout = Math.min(rawPayout, cert.capUsdc);
  }

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

  // Update pool state
  store.updatePool((p) => {
    if (payout > 0) p.reservesUsdc -= payout;
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
      settlementPriceE6: pyth.priceE6,
      conservativePriceE6,
      payout,
      state: newState,
    },
    store.getVersion(),
    "success",
    txSig
  );

  return {
    payout,
    state: newState,
    settlementPriceE6: pyth.priceE6,
    conservativePriceE6,
  };
}
