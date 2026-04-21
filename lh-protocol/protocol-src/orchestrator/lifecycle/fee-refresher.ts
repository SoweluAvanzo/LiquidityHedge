/**
 * Fee refresher — refreshes the on-chain position account's
 * `fee_owed_{a,b}` by sending an `update_fees_and_rewards` ix,
 * then reads the post-refresh values. Returns the accrued fees
 * converted into micro-USDC (token A × price + token B).
 *
 * Called by the Certificate Lifecycle Manager just before settlement
 * so the emulator's settlement uses real accrued fees, not a synthetic
 * formula.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { buildUpdateFeesAndRewardsIx } from "../../position-escrow/orca-adapter";
import { decodePositionAccount } from "../../market-data/decoder";

export interface FeeRefreshContext {
  connection: Connection;
  payer: Keypair;
  whirlpool: PublicKey;
  positionPda: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  /** Settlement price in micro-USD — used to convert token A (SOL lamports) into USDC */
  settlementPriceE6: number;
}

export interface FeeRefreshResult {
  txSignature: string;
  feeOwedALamports: bigint;
  feeOwedBMicroUsdc: bigint;
  /** Sum of both legs converted to micro-USDC */
  feesAccruedUsdc: number;
}

/**
 * Send `update_fees_and_rewards` and read back the refreshed fee_owed
 * values. Total is returned in micro-USDC, suitable as the `feesAccrued`
 * arg to `OffchainLhProtocol.settleCertificate`.
 */
export async function refreshAndReadFees(
  ctx: FeeRefreshContext,
): Promise<FeeRefreshResult> {
  const tx = new Transaction();
  tx.add(
    buildUpdateFeesAndRewardsIx({
      whirlpool: ctx.whirlpool,
      positionPda: ctx.positionPda,
      tickArrayLower: ctx.tickArrayLower,
      tickArrayUpper: ctx.tickArrayUpper,
    }),
  );
  const txSignature = await sendAndConfirmTransaction(
    ctx.connection,
    tx,
    [ctx.payer],
    { commitment: "confirmed" },
  );

  const posAcct = await ctx.connection.getAccountInfo(ctx.positionPda);
  if (!posAcct) {
    throw new Error(`Position account ${ctx.positionPda.toBase58()} not found after fee refresh`);
  }
  const pd = decodePositionAccount(Buffer.from(posAcct.data));
  const feeAUsdc = Math.floor(
    (Number(pd.feeOwedA) * ctx.settlementPriceE6) / 1_000_000_000,
  );
  const feeBUsdc = Number(pd.feeOwedB);
  return {
    txSignature,
    feeOwedALamports: pd.feeOwedA,
    feeOwedBMicroUsdc: pd.feeOwedB,
    feesAccruedUsdc: feeAUsdc + feeBUsdc,
  };
}
