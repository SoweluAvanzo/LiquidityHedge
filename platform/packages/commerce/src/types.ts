/**
 * Data-product commerce: orders, payments, fulfilment.
 *
 * Design rules (identical discipline to the certificate ledger):
 *  - the platform holds NO keys for the revenue address — it only observes;
 *  - fulfilment happens only on a FINALIZED, fully verified on-chain
 *    payment, never on a client assertion;
 *  - idempotent on the transaction signature; one order → one fulfilment.
 */

export type ProductId = "dataset-2026-forward" | "dataset-archive-preorder";

export interface ProductSpec {
  id: ProductId;
  name: string;
  /** Price in µUSDC (1 USDC = 1_000_000). */
  priceUsdc: number;
  /** Pre-order products are not fulfilled automatically. */
  preOrder: boolean;
}

export const PRODUCTS: Record<ProductId, ProductSpec> = {
  "dataset-2026-forward": {
    id: "dataset-2026-forward",
    name: "Orca fee-growth dataset — 2026 forward",
    priceUsdc: 1_000_000,
    preOrder: false,
  },
  "dataset-archive-preorder": {
    id: "dataset-archive-preorder",
    name: "Orca fee-growth archive 2023–2026 (pre-order)",
    priceUsdc: 200_000_000,
    preOrder: true,
  },
};

export type OrderStatus = "awaiting-payment" | "paid" | "fulfilled" | "expired" | "refund-due";

export interface Order {
  orderId: string;
  productId: ProductId;
  /** Exact amount to pay, µUSDC — carries the unique-cents order tag. */
  amountUsdc: number;
  /** Solana Pay reference key (base58) — the primary payment binding. */
  reference: string;
  /** Buyer wallet when connected; null for manual/exchange payments. */
  buyerWallet: string | null;
  /** Contact for delivery (pre-orders and manual flows). */
  email: string | null;
  createdAtTs: number;
  expiresAtTs: number;
  status: OrderStatus;
  payment?: PaymentProof;
  /**
   * SHA-256 of the order's claim secret. The raw secret is returned ONCE,
   * to whoever created the order, and never stored.
   *
   * AUDIT #9: the download grant used to be handed to whoever asked for
   * `?orderId=…`, and the orderId is published on-chain in the payment
   * memo — so anyone watching the revenue wallet could poll for a victim's
   * order and win the grant. The orderId identifies; this authenticates.
   */
  claimHash?: string;
  /** Single-use, short-lived download grant (set at fulfilment). */
  downloadToken?: string;
  downloadExpiresAtTs?: number;
}

export interface PaymentProof {
  txSignature: string;
  amountUsdc: number;
  senderWallet: string;
  slot: number;
  observedAtTs: number;
}

export interface CommerceConfig {
  /** Externally managed (multisig) revenue address — receive only. */
  revenueWallet: string;
  usdcMint: string;
  /** How long a quoted order stays payable. */
  orderTtlSeconds: number;
  /** Download grant lifetime after fulfilment. */
  downloadTtlSeconds: number;
  /** Below this, refunds cost more than the payment — stated at checkout. */
  minRefundUsdc: number;
}

export class OrderError extends Error {}
