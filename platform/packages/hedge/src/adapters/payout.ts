/**
 * Payout instruction builder (settlements + refunds). Pure construction —
 * the hot-wallet service signs and sends; keys never enter this package
 * (NFR-SEC3/SR-8). ATA creation is idempotent so first-time recipients
 * work; the ~0.002 SOL ATA rent is borne by the payer per Master Terms
 * §4.4/§7.2 economics.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assertUsdcInt } from "../types";

export const USDC_DECIMALS = 6;

export interface PayoutParams {
  /** Hot wallet (signer, fee payer, source-ATA owner). */
  fromWallet: PublicKey;
  toWallet: PublicKey;
  usdcMint: PublicKey;
  amountUsdc: number;
  /** SPL-Memo reference tying the payout to a certificate/refund. */
  memo: string;
}

export function buildPayoutInstructions(params: PayoutParams): TransactionInstruction[] {
  assertUsdcInt(params.amountUsdc, "amountUsdc");
  if (params.amountUsdc === 0) throw new Error("zero-amount payout");
  const fromAta = getAssociatedTokenAddressSync(params.usdcMint, params.fromWallet);
  const toAta = getAssociatedTokenAddressSync(params.usdcMint, params.toWallet);
  const memoIx = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [{ pubkey: params.fromWallet, isSigner: true, isWritable: false }],
    data: Buffer.from(params.memo, "utf8"),
  });
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      params.fromWallet,
      toAta,
      params.toWallet,
      params.usdcMint,
    ),
    createTransferCheckedInstruction(
      fromAta,
      params.usdcMint,
      toAta,
      params.fromWallet,
      BigInt(params.amountUsdc),
      USDC_DECIMALS,
    ),
    memoIx,
  ];
}
