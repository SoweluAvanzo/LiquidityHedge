/**
 * Wire types for /api/hedge/* — the JSON shapes shared by the route
 * handlers (serializers) and the purchase panel (consumer). QuoteRecord,
 * CertificateRecord and TermSheet are already JSON-safe (all money is
 * integer µUSDC numbers; position liquidity crosses as a decimal
 * string), so the domain types are reused directly — type-only imports,
 * nothing from @lh/hedge reaches the browser bundle.
 */

import type { CertificateRecord, QuoteRecord, TermSheet } from "@lh/hedge";

/** Wrapped SOL mint — hedge eligibility is SOL/USDC only. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface HedgePaymentInstructions {
  treasuryAddress: string;
  /** Exact amount due, integer µUSDC (Premium + Collateral). */
  amountUsdc: number;
  /** Unique payment reference — must be the transfer memo, verbatim. */
  memoReference: string;
  /** Unix seconds; the quote (and these instructions) lapse after this. */
  expiresAtTs: number;
}

export interface HedgeQuoteResponse {
  quote: QuoteRecord;
  termSheet: TermSheet;
  termSheetHash: string;
  /** The six acknowledgment texts (legal doc 03), server-provided. */
  consentItems: string[];
  paymentInstructions: HedgePaymentInstructions;
  /**
   * C6: EVERY input behind the premium, shown with the quote — tenor,
   * σ, IV/RV (with source), markup floor, effective markup, fee split
   * y, expected daily fee, premium floor, protocol fee. Nothing about
   * the price is left to be taken on faith.
   */
  pricingInputs: {
    tenorDays: number;
    sigmaAnnual: number;
    ivRvRatio: number;
    ivSource: string;
    ivFallbackUsed: boolean;
    markupFloor: number;
    effectiveMarkup: number;
    feeSplitRate: number;
    expectedDailyFee: number;
    premiumFloorUsdc: number;
    protocolFeeBps: number;
  };
}

export interface HedgeMonitorWire {
  netReservesUsdc: number;
  activeExposureUsdc: number;
  paused: boolean;
  invariants: { ok: boolean; failures: string[] };
  /**
   * C4: "published reserves … verifiable on-chain" made true. The
   * ledger figure is reconciled against the treasury USDC ATA read at
   * finalized commitment on every status call; a divergence beyond the
   * tolerance ALSO appends to invariants.failures. onChainUsdc null =
   * the chain could not be read (labelled unverified, never assumed).
   */
  reserves: {
    ledgerUsdc: number;
    onChainUsdc: number | null;
    deltaUsdc: number | null;
    reconciled: boolean | null;
  };
}

export interface HedgeStatusResponse {
  /** True when the server runs with HEDGE_DEV_MODE=1 (dev buttons). */
  devMode: boolean;
  treasuryAddress: string;
  /** True once the ledger holds anything beyond LedgerOpened. */
  hasActivity: boolean;
  monitor: HedgeMonitorWire;
  consentItems: string[];
  /** Present when looked up by quoteId or positionMint. */
  quote?: QuoteRecord;
  certificate?: CertificateRecord;
}

export interface HedgeSettleResult {
  quoteId: string;
  priceUsd: number;
  payoffUsdc: number;
  feeSplitUsdc: number;
  settlementAmountUsdc: number;
  to: string;
  finalStatus: "settled" | "expired";
}

export interface HedgeError {
  error: string;
}

/*
 * Money and countdown formatting live in `@/lib/format` — one module for
 * the whole app so the hedge panel and the data checkout round identically
 * (FR-L3: money is never shown as a bare number).
 */
