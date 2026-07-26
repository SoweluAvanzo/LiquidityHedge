/**
 * Pure parsing of finalized transactions into ObservedTransfer records.
 *
 * Strategy (robust across transfer/transferChecked/CPI shapes): read the
 * treasury ATA's USDC balance DELTA from meta pre/post token balances —
 * what actually arrived — plus the SPL-Memo instruction as the payment
 * reference and the fee payer as the sender wallet. Failed transactions
 * and non-positive deltas yield null.
 */

import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { ObservedTransfer } from "../types";

export interface PaymentParseParams {
  treasuryAta: string;
  usdcMint: string;
}

export function extractUsdcPayment(
  tx: ParsedTransactionWithMeta,
  params: PaymentParseParams,
): ObservedTransfer | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const keys = tx.transaction.message.accountKeys;
  const ataIndex = keys.findIndex((k) => k.pubkey.toBase58() === params.treasuryAta);
  if (ataIndex < 0) return null;

  const balanceOf = (
    list: typeof meta.preTokenBalances,
  ): bigint | null => {
    const entry = list?.find(
      (b) => b.accountIndex === ataIndex && b.mint === params.usdcMint,
    );
    return entry ? BigInt(entry.uiTokenAmount.amount) : null;
  };
  const pre = balanceOf(meta.preTokenBalances) ?? 0n;
  const post = balanceOf(meta.postTokenBalances);
  if (post === null) return null;
  const delta = post - pre;
  if (delta <= 0n) return null;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) return null; // implausible; refuse

  // Memo = the payment reference (Master Terms §4.2).
  let referenceKey = "";
  for (const ix of tx.transaction.message.instructions) {
    const p = ix as { program?: string; parsed?: unknown };
    if (p.program === "spl-memo" && typeof p.parsed === "string") {
      referenceKey = p.parsed.trim();
      break;
    }
  }
  if (referenceKey === "") return null; // unreferenced deposits are not payments

  const feePayer = keys.find((k) => k.signer)?.pubkey.toBase58() ?? "";
  if (feePayer === "") return null;

  return {
    txSignature: tx.transaction.signatures[0],
    referenceKey,
    senderWallet: feePayer,
    amountUsdc: Number(delta),
  };
}
