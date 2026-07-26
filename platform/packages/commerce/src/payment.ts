/**
 * Solana Pay payment construction and verification.
 *
 * The reference key is an unguessable public key attached to the transfer
 * as a read-only, non-signer account. It makes the payment directly
 * indexable (`getSignaturesForAddress(reference)`) instead of scanning all
 * treasury traffic, and it is the standard Solana Pay binding.
 *
 * For manual payments (exchange withdrawals, wallets that cannot attach
 * accounts) the order's amount carries unique micro-cents, so the payment
 * can still be bound unambiguously.
 */

import { randomInt } from "crypto";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Order, OrderError } from "./types";

export const USDC_DECIMALS = 6;

/** Fresh, unguessable reference key (never signs, never holds funds). */
export function createReference(): string {
  return Keypair.generate().publicKey.toBase58();
}

/** Tag space: 16 bits (0–65535 µUSDC ≈ ≤ $0.066 — invisible at these prices). */
export const TAG_SPACE = 65_536;

/**
 * Unique-cents tag so manual payments are identifiable by amount alone.
 *
 * SECURITY (A7): drawn with a CSPRNG, not hashed from the order id. A
 * deterministic 10-bit hash was both grindable (an attacker could mint
 * orders until one collided with a victim's amount) and collision-prone
 * (~38 concurrent orders gave a >50% birthday collision). `taken` lets
 * the caller guarantee uniqueness among currently open orders.
 */
export function taggedAmount(baseUsdc: number, taken?: ReadonlySet<number>): number {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = baseUsdc + randomInt(TAG_SPACE);
    if (!taken?.has(candidate)) return candidate;
  }
  throw new OrderError("could not allocate a unique payment amount — too many open orders");
}

export interface PaymentRequest {
  /** Solana Pay URL for QR codes and wallet deep links. */
  url: string;
  recipient: string;
  amountUsdc: number;
  reference: string;
  memo: string;
}

export function buildPaymentRequest(
  order: Order,
  revenueWallet: string,
  usdcMint: string,
  label = "Liquidity Hedge",
): PaymentRequest {
  const amount = (order.amountUsdc / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
  const memo = `LH:${order.orderId}`;
  const url =
    `solana:${revenueWallet}` +
    `?amount=${amount}` +
    `&spl-token=${usdcMint}` +
    `&reference=${order.reference}` +
    `&label=${encodeURIComponent(label)}` +
    `&message=${encodeURIComponent(PRODUCT_MESSAGE)}` +
    `&memo=${encodeURIComponent(memo)}`;
  return {
    url,
    recipient: revenueWallet,
    amountUsdc: order.amountUsdc,
    reference: order.reference,
    memo,
  };
}

const PRODUCT_MESSAGE = "Liquidity Hedge dataset";

/**
 * Instructions for the wallet-signed path: the app PROPOSES this
 * transaction, the user approves it in their own wallet. The platform
 * never signs and never has authority over the funds.
 */
export function buildPaymentInstructions(params: {
  buyerWallet: PublicKey;
  revenueWallet: PublicKey;
  usdcMint: PublicKey;
  amountUsdc: number;
  reference: PublicKey;
  memo: string;
}): TransactionInstruction[] {
  if (!Number.isSafeInteger(params.amountUsdc) || params.amountUsdc <= 0) {
    throw new OrderError(`invalid amount ${params.amountUsdc}`);
  }
  const fromAta = getAssociatedTokenAddressSync(params.usdcMint, params.buyerWallet);
  const toAta = getAssociatedTokenAddressSync(params.usdcMint, params.revenueWallet);

  const transfer = createTransferCheckedInstruction(
    fromAta,
    params.usdcMint,
    toAta,
    params.buyerWallet,
    BigInt(params.amountUsdc),
    USDC_DECIMALS,
  );
  // Solana Pay: the reference rides along as a read-only, non-signer key,
  // making the payment directly indexable.
  transfer.keys.push({ pubkey: params.reference, isSigner: false, isWritable: false });

  const memoIx = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [{ pubkey: params.buyerWallet, isSigner: true, isWritable: false }],
    data: Buffer.from(params.memo, "utf8"),
  });

  return [
    // Idempotent: harmless if the revenue ATA already exists.
    createAssociatedTokenAccountIdempotentInstruction(
      params.buyerWallet,
      toAta,
      params.revenueWallet,
      params.usdcMint,
    ),
    transfer,
    memoIx,
  ];
}

// ── Verification ────────────────────────────────────────────────────

export interface ParsedTxLike {
  slot: number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: { toBase58(): string }; signer: boolean }[];
    };
  };
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalanceLike[] | null;
    postTokenBalances?: TokenBalanceLike[] | null;
  } | null;
}

interface TokenBalanceLike {
  accountIndex: number;
  mint: string;
  uiTokenAmount: { amount: string };
}

export interface VerifyParams {
  /** Revenue ATA that must receive the funds. */
  revenueAta: string;
  usdcMint: string;
  /** Exact amount required (µUSDC). */
  expectedAmountUsdc: number;
}

export type VerifyResult =
  | { ok: true; amountUsdc: number; senderWallet: string; txSignature: string; slot: number }
  | { ok: false; reason: string };

/**
 * Verify a candidate payment transaction. Deliberately strict: the credited
 * amount is read from the ATA's balance DELTA (robust across transfer /
 * transferChecked / CPI shapes), the mint must match, the transaction must
 * have succeeded, and the amount must be exact.
 */
export function verifyPayment(tx: ParsedTxLike, params: VerifyParams): VerifyResult {
  const meta = tx.meta;
  if (!meta) return { ok: false, reason: "no transaction metadata" };
  if (meta.err) return { ok: false, reason: "transaction failed on-chain" };

  const keys = tx.transaction.message.accountKeys;
  const ataIndex = keys.findIndex((k) => k.pubkey.toBase58() === params.revenueAta);
  if (ataIndex < 0) return { ok: false, reason: "revenue account not in transaction" };

  const balanceAt = (list: TokenBalanceLike[] | null | undefined): bigint | null => {
    const e = list?.find((b) => b.accountIndex === ataIndex && b.mint === params.usdcMint);
    return e ? BigInt(e.uiTokenAmount.amount) : null;
  };
  const post = balanceAt(meta.postTokenBalances);
  if (post === null) return { ok: false, reason: "wrong mint or no token balance" };
  const delta = post - (balanceAt(meta.preTokenBalances) ?? 0n);
  if (delta <= 0n) return { ok: false, reason: "no inbound transfer" };
  if (delta !== BigInt(params.expectedAmountUsdc)) {
    return {
      ok: false,
      reason: `amount mismatch: received ${delta}, expected ${params.expectedAmountUsdc}`,
    };
  }

  const sender = keys.find((k) => k.signer)?.pubkey.toBase58();
  if (!sender) return { ok: false, reason: "no signer found" };

  return {
    ok: true,
    amountUsdc: Number(delta),
    senderWallet: sender,
    txSignature: tx.transaction.signatures[0],
    slot: tx.slot,
  };
}
