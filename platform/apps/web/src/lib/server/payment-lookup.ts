/**
 * On-chain payment lookup for data orders.
 *
 * The Solana Pay reference key makes this a direct index lookup rather
 * than a scan of all treasury traffic: any transaction that included the
 * reference as a read-only key is returned by getSignaturesForAddress.
 *
 * Everything is then re-verified from the transaction itself (mint,
 * recipient ATA, exact amount, success) at `finalized` commitment — the
 * reference only tells us WHERE to look, never that a payment is valid.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { verifyPayment, type VerifyResult } from "@lh/commerce";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export function serverConnection(): Connection {
  return new Connection(process.env.RPC_URL ?? DEFAULT_RPC, "finalized");
}

export interface LookupResult {
  found: boolean;
  verified?: VerifyResult;
  /** Signatures inspected — useful for diagnostics, never shown raw to users. */
  candidates: number;
}

/**
 * Find and verify the payment for an order. Returns the first candidate
 * that passes full verification; a candidate that fails verification is
 * reported so the caller can surface a precise reason (wrong amount, etc.).
 */
export async function findVerifiedPayment(params: {
  connection: Connection;
  reference: string;
  revenueWallet: string;
  usdcMint: string;
  expectedAmountUsdc: number;
}): Promise<LookupResult> {
  const revenueAta = getAssociatedTokenAddressSync(
    new PublicKey(params.usdcMint),
    new PublicKey(params.revenueWallet),
  ).toBase58();

  // SECURITY (A6): paginate. The reference becomes public once the buyer's
  // transfer lands, so an attacker can spam cheap transactions naming it to
  // push the genuine payment out of a fixed window. We walk pages until the
  // payment is found or the budget is exhausted.
  const PAGE = 50;
  const MAX_PAGES = 10; // up to 500 candidates
  let before: string | undefined;
  let inspected = 0;
  let lastFailure: VerifyResult | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await params.connection.getSignaturesForAddress(
      new PublicKey(params.reference),
      { limit: PAGE, before },
      "finalized",
    );
    if (sigs.length === 0) break;
    for (const sig of sigs) {
      inspected++;
      if (sig.err) continue; // failed transactions can never be a payment
      const tx = await params.connection.getParsedTransaction(sig.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const result = verifyPayment(tx as never, {
        revenueAta,
        usdcMint: params.usdcMint,
        expectedAmountUsdc: params.expectedAmountUsdc,
      });
      if (result.ok) return { found: true, verified: result, candidates: inspected };
      lastFailure = result;
    }
    if (sigs.length < PAGE) break;
    before = sigs[sigs.length - 1].signature;
  }
  return { found: false, verified: lastFailure, candidates: inspected };
}
