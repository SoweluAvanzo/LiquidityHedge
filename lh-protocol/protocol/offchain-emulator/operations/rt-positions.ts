/**
 * RT position operations (v2): deposit, early withdrawal, expiry withdrawal.
 * RT deposits SOL + USDC → vault opens an escrowed Orca position.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  RtPositionState,
  RtPositionStatus,
  BPS,
  DepositRtResult,
  WithdrawRtResult,
} from "../../types";
import { StateStore } from "../state/store";
import { AuditLogger } from "../audit/logger";
import {
  openVaultPosition,
  closeVaultPosition,
  computeRtTickRange,
} from "./vault-positions";
import {
  decodeWhirlpoolAccount,
  sqrtPriceX64ToPrice,
} from "../../../clients/cli/whirlpool-ix";
import {
  estimateTokenAmounts,
  positionValueUsd,
} from "../../../clients/cli/position-value";
import { tickToSqrtPriceX64, priceToSqrtPriceX64 } from "../../../clients/cli/whirlpool-ix";
import { transferFromVault } from "../chain/token-ops";
import { WHIRLPOOL_ADDRESS } from "../../../clients/cli/config";

/**
 * RT deposits SOL + USDC. Vault opens a wider Orca position on their behalf.
 */
export async function depositRt(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  rt: Keypair,
  solAmount: number,
  usdcAmount: number,
  expiryTs: number,
  linkedCertMint?: string,
): Promise<DepositRtResult> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  // Get whirlpool data for tick range computation
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  if (!wpInfo) throw new Error("Whirlpool not found");
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo.data));

  // Compute tick range
  let lowerTick: number;
  let upperTick: number;
  const widthMultiplier = pool.rtTickWidthMultiplier ?? 2;

  if (linkedCertMint) {
    // Link to LP's cert — use wider range around LP's position
    const lpPos = store.getPosition(linkedCertMint);
    if (!lpPos) throw new Error(`LP position not found: ${linkedCertMint}`);
    const rtRange = computeRtTickRange(
      lpPos.lowerTick, lpPos.upperTick, wp.tickSpacing, widthMultiplier
    );
    lowerTick = rtRange.lowerTick;
    upperTick = rtRange.upperTick;
  } else {
    // Unmatched deposit — use default wider range around current price
    const { alignTick } = await import("../../../clients/cli/whirlpool-ix");
    const defaultWidth = 400 * widthMultiplier;
    lowerTick = alignTick(wp.tickCurrentIndex - defaultWidth / 2, wp.tickSpacing, "down");
    upperTick = alignTick(wp.tickCurrentIndex + defaultWidth / 2, wp.tickSpacing, "up");
  }

  // Open vault-managed position
  const result = await openVaultPosition(
    connection, vaultKeypair, wp,
    BigInt(solAmount), BigInt(usdcAmount),
    lowerTick, upperTick,
  );

  const now = Math.floor(Date.now() / 1000);
  const rtPos: RtPositionState = {
    rtOwner: rt.publicKey.toBase58(),
    positionMint: result.positionMint.toBase58(),
    whirlpool: WHIRLPOOL_ADDRESS.toBase58(),
    lowerTick: result.lowerTick,
    upperTick: result.upperTick,
    liquidity: result.liquidity.toString(),
    depositedSol: Number(result.actualSolLamports),
    depositedUsdc: Number(result.actualUsdcMicro),
    entryPriceE6: Math.floor(result.entryPrice * 1e6),
    depositTs: now,
    expiryTs,
    linkedLpPositionMint: linkedCertMint || null,
    status: RtPositionStatus.ACTIVE,
    earlyExitPenaltyPaid: 0,
  };
  store.addRtPosition(rtPos);

  // If linked, update the certificate with RT reference
  if (linkedCertMint) {
    const cert = store.getCertificate(linkedCertMint);
    if (cert) {
      store.updateCertificate(linkedCertMint, (c) => {
        c.rtPositionMint = result.positionMint.toBase58();
      });
    }
    // Assign RT to premium escrow
    const escrow = store.getPremiumEscrow(linkedCertMint);
    if (escrow) {
      store.updatePremiumEscrow(linkedCertMint, (e) => {
        e.rtOwner = rt.publicKey.toBase58();
      });
    }
  }

  // Also add to pool shares (RT's deposit increases reserves)
  store.updatePool((p) => {
    p.reservesUsdc += Number(result.actualUsdcMicro);
  });
  const shares = Number(result.actualUsdcMicro); // simplified: 1:1 for USDC portion
  store.addShares(rt.publicKey.toBase58(), shares);

  logger.logOperation("depositRt", {
    rt: rt.publicKey.toBase58(),
    positionMint: result.positionMint.toBase58(),
    solDeposited: Number(result.actualSolLamports),
    usdcDeposited: Number(result.actualUsdcMicro),
    lowerTick, upperTick,
    linkedCertMint,
  }, store.getVersion());

  return {
    rtPositionMint: result.positionMint.toBase58(),
    lowerTick: result.lowerTick,
    upperTick: result.upperTick,
    liquidity: result.liquidity.toString(),
    actualSol: Number(result.actualSolLamports),
    actualUsdc: Number(result.actualUsdcMicro),
  };
}

/**
 * RT early withdrawal: penalty applied, settlement triggered, replacement sought.
 */
export async function withdrawRtEarly(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  rt: Keypair,
  rtPositionMint: string,
): Promise<WithdrawRtResult> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const rtPos = store.getRtPosition(rtPositionMint);
  if (!rtPos) throw new Error(`RT position not found: ${rtPositionMint}`);
  if (rtPos.rtOwner !== rt.publicKey.toBase58()) throw new Error("Unauthorized");
  if (rtPos.status !== RtPositionStatus.ACTIVE) throw new Error("RT position not active");

  const now = Math.floor(Date.now() / 1000);
  if (now >= rtPos.expiryTs) throw new Error("Use withdrawRtAtExpiry for expired positions");

  // Compute penalty
  const timeServedRatio = (now - rtPos.depositTs) / (rtPos.expiryTs - rtPos.depositTs);
  const timeRemainingRatio = 1 - timeServedRatio;
  const penaltyBps = pool.earlyExitPenaltyBps ?? 0;

  // Current RT position value
  const wpInfo = await connection.getAccountInfo(WHIRLPOOL_ADDRESS);
  const wp = decodeWhirlpoolAccount(Buffer.from(wpInfo!.data));
  const currentPrice = sqrtPriceX64ToPrice(wp.sqrtPrice);
  const liquidity = BigInt(rtPos.liquidity);
  const sqrtPriceLower = tickToSqrtPriceX64(rtPos.lowerTick);
  const sqrtPriceUpper = tickToSqrtPriceX64(rtPos.upperTick);
  const amounts = estimateTokenAmounts(liquidity, wp.sqrtPrice, sqrtPriceLower, sqrtPriceUpper);
  const posValue = positionValueUsd(amounts.amountA, amounts.amountB, currentPrice);
  const posValueUsdc = Math.floor(posValue * 1e6);

  const penaltyUsdc = Math.floor((posValueUsdc * penaltyBps * timeRemainingRatio) / BPS);

  // Deferred premium: earned portion proportional to time served
  let deferredPremiumEarned = 0;
  let deferredPremiumForfeited = 0;
  if (rtPos.linkedLpPositionMint) {
    const escrow = store.getPremiumEscrow(rtPos.linkedLpPositionMint);
    if (escrow && !escrow.released) {
      deferredPremiumEarned = Math.floor(escrow.deferredAmountUsdc * timeServedRatio);
      deferredPremiumForfeited = escrow.deferredAmountUsdc - deferredPremiumEarned;
      store.updatePremiumEscrow(rtPos.linkedLpPositionMint, (e) => {
        e.accruedAmountUsdc = deferredPremiumEarned;
      });
    }
  }

  // Close RT's Orca position
  await closeVaultPosition(
    connection, vaultKeypair,
    new PublicKey(rtPositionMint),
    liquidity, rtPos.lowerTick, rtPos.upperTick,
  );

  // Create replacement request if linked to LP cert
  let replacementRequestCreated = false;
  if (rtPos.linkedLpPositionMint) {
    store.addReplacementRequest({
      certPositionMint: rtPos.linkedLpPositionMint,
      requiredSol: rtPos.depositedSol,
      requiredUsdc: rtPos.depositedUsdc,
      penaltyFundsUsdc: penaltyUsdc + deferredPremiumForfeited,
      createdTs: now,
      expiryTs: rtPos.expiryTs,
      status: "open",
    });
    replacementRequestCreated = true;

    // Unlink RT from certificate
    store.updateCertificate(rtPos.linkedLpPositionMint, (c) => {
      c.rtPositionMint = null;
    });
  }

  // Update RT position state
  store.updateRtPosition(rtPositionMint, (p) => {
    p.status = RtPositionStatus.EXITED_EARLY;
    p.earlyExitPenaltyPaid = penaltyUsdc;
  });

  // Update pool reserves (remove RT's contribution, add penalty)
  store.updatePool((p) => {
    p.reservesUsdc -= rtPos.depositedUsdc;
    p.reservesUsdc += penaltyUsdc;
  });

  logger.logOperation("withdrawRtEarly", {
    rt: rt.publicKey.toBase58(),
    rtPositionMint,
    penaltyUsdc,
    deferredPremiumEarned,
    deferredPremiumForfeited,
    replacementRequestCreated,
  }, store.getVersion());

  return {
    returnedSol: Number(amounts.amountA),
    returnedUsdc: Number(amounts.amountB) - penaltyUsdc + deferredPremiumEarned,
    penaltyUsdc,
    deferredPremiumEarned,
    deferredPremiumForfeited,
    feeShareA: 0,
    feeShareB: 0,
    replacementRequestCreated,
  };
}

/**
 * RT withdrawal at/after expiry: full deferred premium + fee share.
 */
export async function withdrawRtAtExpiry(
  store: StateStore,
  logger: AuditLogger,
  connection: Connection,
  vaultKeypair: Keypair,
  rt: Keypair,
  rtPositionMint: string,
): Promise<WithdrawRtResult> {
  const pool = store.getPool();
  if (!pool) throw new Error("Pool not initialized");

  const rtPos = store.getRtPosition(rtPositionMint);
  if (!rtPos) throw new Error(`RT position not found: ${rtPositionMint}`);
  if (rtPos.rtOwner !== rt.publicKey.toBase58()) throw new Error("Unauthorized");
  if (rtPos.status !== RtPositionStatus.ACTIVE) throw new Error("RT position not active");

  const now = Math.floor(Date.now() / 1000);
  if (now < rtPos.expiryTs) throw new Error("Position not yet expired");

  // Release full deferred premium
  let deferredPremiumEarned = 0;
  if (rtPos.linkedLpPositionMint) {
    const escrow = store.getPremiumEscrow(rtPos.linkedLpPositionMint);
    if (escrow && !escrow.released) {
      deferredPremiumEarned = escrow.deferredAmountUsdc;
      store.updatePremiumEscrow(rtPos.linkedLpPositionMint, (e) => {
        e.accruedAmountUsdc = e.deferredAmountUsdc;
        e.released = true;
      });
    }
  }

  // Fee share from linked LP cert (if collected)
  let feeShareA = 0;
  let feeShareB = 0;
  if (rtPos.linkedLpPositionMint) {
    const cert = store.getCertificate(rtPos.linkedLpPositionMint);
    if (cert) {
      const shareBps = cert.feeShareBps ?? 0;
      feeShareA = Math.floor(((cert.collectedFeesA ?? 0) * shareBps) / BPS);
      feeShareB = Math.floor(((cert.collectedFeesB ?? 0) * shareBps) / BPS);
    }
  }

  // Close RT's Orca position
  const liquidity = BigInt(rtPos.liquidity);
  await closeVaultPosition(
    connection, vaultKeypair,
    new PublicKey(rtPositionMint),
    liquidity, rtPos.lowerTick, rtPos.upperTick,
  );

  // Update RT position state
  store.updateRtPosition(rtPositionMint, (p) => {
    p.status = RtPositionStatus.EXITED_AT_EXPIRY;
  });

  // Update pool reserves
  store.updatePool((p) => {
    p.reservesUsdc -= rtPos.depositedUsdc;
  });

  logger.logOperation("withdrawRtAtExpiry", {
    rt: rt.publicKey.toBase58(),
    rtPositionMint,
    deferredPremiumEarned,
    feeShareA, feeShareB,
  }, store.getVersion());

  return {
    returnedSol: rtPos.depositedSol,
    returnedUsdc: rtPos.depositedUsdc + deferredPremiumEarned + feeShareB,
    penaltyUsdc: 0,
    deferredPremiumEarned,
    deferredPremiumForfeited: 0,
    feeShareA,
    feeShareB,
    replacementRequestCreated: false,
  };
}
