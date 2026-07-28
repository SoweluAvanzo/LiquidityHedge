/**
 * Wire types and product copy for /api/data/* — the JSON shapes shared by
 * the route handlers (serializers) and the checkout (consumer).
 *
 * The catalog below carries only presentation copy. Prices, the pre-order
 * flag and the payable amount always come from the server response; the
 * client never computes what is owed.
 */

export type DataProductId = "dataset-2026-forward" | "dataset-archive-preorder";

export type DataOrderStatus =
  | "awaiting-payment"
  | "paid"
  | "fulfilled"
  | "expired"
  | "refund-due";

export interface DataPaymentInstructions {
  /** Externally managed revenue address — receive only. */
  recipient: string;
  /** Solana Pay reference key: makes the payment directly indexable. */
  reference: string;
  /** Memo the transfer must carry, verbatim. */
  memo: string;
  /** solana: URL for wallet deep links. */
  solanaPayUrl: string;
}

export interface DataOrderResponse {
  /**
   * Per-order claim secret, returned ONCE at creation (AUDIT #9). The
   * orderId travels on-chain in the payment memo and is public; this is
   * what proves the caller is the buyer when collecting the download
   * grant. Held in sessionStorage, never logged.
   */
  claimSecret: string;
  orderId: string;
  productId: DataProductId;
  productName: string;
  preOrder: boolean;
  /** Exact amount to pay, integer µUSDC — carries this order's tag. */
  amountUsdc: number;
  expiresAtTs: number;
  payment: DataPaymentInstructions;
  /**
   * B1: what the dataset contains RIGHT NOW, quoted before payment from
   * the same table the download streams from. Null on pre-orders
   * (nothing collected yet) or when the store could not be queried —
   * the UI says so rather than showing a stale figure.
   */
  coverage: {
    rows: number;
    pools: number;
    firstT: number | null;
    lastT: number | null;
  } | null;
}

export interface DataStatusResponse {
  orderId: string;
  status: DataOrderStatus;
  preOrder: boolean;
  amountUsdc: number;
  expiresAtTs: number;
  /** Returned exactly once, at the moment of fulfilment. */
  downloadToken: string | null;
  downloadExpiresAtTs: number | null;
  /** Server-side explanation of an unusual observation, if any. */
  note: string | null;
}

export interface DataProductCopy {
  id: DataProductId;
  name: string;
  price: string;
  priceUnit: string;
  /**
   * List price in µUSDC — presentation only. The payable amount always
   * comes from the server and carries a random per-order tag on top of
   * this; the checkout uses the list price solely to show which digits of
   * the quoted amount are the tag.
   */
  basePriceUsdc: number;
  /** Availability wording — identical to the landing page's price table. */
  availability: string;
  availabilityTone: "good" | "warning";
  summary: string;
  points: string[];
  /** Pre-orders are delivered by hand, so an email is mandatory. */
  requiresEmail: boolean;
}

export const DATA_PRODUCTS: DataProductCopy[] = [
  {
    id: "dataset-2026-forward",
    name: "Fee-growth dataset · 2026 forward",
    price: "1",
    priceUnit: "USDC",
    basePriceUsdc: 1_000_000,
    availability: "Collecting now",
    availabilityTone: "good",
    summary:
      "The long-format CSV of every tracked Orca Whirlpool: fee accumulators, active liquidity, price and both vault balances, one row per pool per 15-minute snapshot.",
    points: [
      "Delivered as a download immediately after the payment is verified on-chain.",
      "Same 14-field schema as the specification on the landing page.",
      "Covered period and row count are stated in the file you receive.",
    ],
    requiresEmail: false,
  },
  {
    id: "dataset-archive-preorder",
    name: "Historical archive · 2023–2026",
    price: "200",
    priceUnit: "USDC",
    basePriceUsdc: 200_000_000,
    availability: "Pre-order — not yet collected",
    availabilityTone: "warning",
    summary:
      "This dataset does not exist yet. Forward collection started on 26 July 2026, so no snapshot before that date has been taken.",
    points: [
      "Reconstructed on request by replaying archived Solana swap transactions to rebuild the fee accumulators.",
      "Indicative delivery is 4–6 weeks after the order; reconstruction is funded once demand is confirmed.",
      "Delivery is by email — an address is required, and nothing is downloadable today.",
    ],
    requiresEmail: true,
  },
];

/**
 * Width of the per-order amount tag, µUSDC (16 bits, ≤ $0.066) — mirrors
 * `TAG_SPACE` in @lh/commerce. Used only to decide whether a quoted amount
 * still looks tagged before highlighting its digits.
 */
export const DATA_TAG_SPACE = 65_536;

/** Status → the words and the tone used for it everywhere in the app. */
export const DATA_STATUS_LABEL: Record<DataOrderStatus, string> = {
  "awaiting-payment": "Awaiting payment",
  paid: "Payment received",
  fulfilled: "Fulfilled",
  expired: "Expired",
  "refund-due": "Refund due",
};

export const DATA_STATUS_TONE: Record<
  DataOrderStatus,
  "good" | "warning" | "critical"
> = {
  "awaiting-payment": "warning",
  paid: "good",
  fulfilled: "good",
  expired: "warning",
  "refund-due": "critical",
};
