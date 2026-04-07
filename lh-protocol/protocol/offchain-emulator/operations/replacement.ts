/**
 * Replacement RT operations (v2).
 * When an RT exits early, the protocol creates a replacement request.
 * A new RT can fill it, receiving penalty funds as a bonus.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  RtPositionStatus,
  DepositRtResult,
} from "../../types";
import { StateStore } from "../state/store";
import { AuditLogger } from "../audit/logger";
import { depositRt } from "./rt-positions";

/**
 * Fill an open replacement request as a new RT.
 * Opens a new RT position linked to the existing LP certificate.
 * Awards penalty funds as a bonus.
 */
export async function fillReplacementRequest(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  newRt: Keypair,
  certPositionMint: string,
  solAmount: number,
  usdcAmount: number,
): Promise<DepositRtResult & { bonusUsdc: number }> {
  const req = store.getReplacementRequest(certPositionMint);
  if (!req) throw new Error(`No replacement request for: ${certPositionMint}`);
  if (req.status !== "open") throw new Error(`Request is ${req.status}, not open`);

  const now = Math.floor(Date.now() / 1000);
  if (now >= req.expiryTs) {
    store.updateReplacementRequest(certPositionMint, (r) => {
      r.status = "expired";
    });
    throw new Error("Replacement request has expired");
  }

  // Open new RT position linked to the cert
  const result = await depositRt(
    store, logger, connection, vaultKeypair,
    newRt, solAmount, usdcAmount,
    req.expiryTs,
    certPositionMint,
  );

  const bonusUsdc = req.penaltyFundsUsdc;

  // Mark request as filled
  store.updateReplacementRequest(certPositionMint, (r) => {
    r.status = "filled";
  });

  // Create new premium escrow for remaining deferred portion (prorated)
  const cert = store.getCertificate(certPositionMint);
  if (cert && cert.premiumDeferredUsdc) {
    const totalTenor = cert.expiryTs - (cert.expiryTs - (cert.premiumDeferredUsdc > 0 ? cert.expiryTs - req.createdTs : 0));
    const remainingRatio = (req.expiryTs - now) / Math.max(1, req.expiryTs - req.createdTs);
    const remainingDeferred = Math.floor(cert.premiumDeferredUsdc * remainingRatio);

    if (remainingDeferred > 0) {
      // Update existing escrow with new RT
      const escrow = store.getPremiumEscrow(certPositionMint);
      if (escrow) {
        store.updatePremiumEscrow(certPositionMint, (e) => {
          e.rtOwner = newRt.publicKey.toBase58();
          e.deferredAmountUsdc = remainingDeferred;
          e.accruedAmountUsdc = 0;
          e.depositTs = now;
        });
      }
    }
  }

  logger.logOperation("fillReplacementRequest", {
    newRt: newRt.publicKey.toBase58(),
    certPositionMint,
    bonusUsdc,
    rtPositionMint: result.rtPositionMint,
  }, store.getVersion());

  return { ...result, bonusUsdc };
}

/**
 * Expire stale replacement requests past their cert expiry.
 */
export function expireStaleRequests(store: StateStore): number {
  const now = Math.floor(Date.now() / 1000);
  let expired = 0;
  for (const req of store.getOpenReplacementRequests()) {
    if (now >= req.expiryTs) {
      store.updateReplacementRequest(req.certPositionMint, (r) => {
        r.status = "expired";
      });
      expired++;
    }
  }
  return expired;
}
