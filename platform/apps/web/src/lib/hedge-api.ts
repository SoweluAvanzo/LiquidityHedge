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
}

export interface HedgeMonitorWire {
  netReservesUsdc: number;
  activeExposureUsdc: number;
  paused: boolean;
  invariants: { ok: boolean; failures: string[] };
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

/**
 * µUSDC → "$1.50" with an explicit "$" and 2–6 decimals (FR-L3: money is
 * never shown as a bare number). Adaptive precision: whole-dollar sums
 * get 2 decimals, sub-dollar 4, sub-cent 6.
 */
export function formatUsdc(micro: number): string {
  const usd = micro / 1e6;
  const abs = Math.abs(usd);
  const decimals = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 4 : 6;
  const magnitude = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${usd < 0 ? "−" : ""}$${magnitude}`;
}

/** µUSDC → "$12.345678" — full 6-decimal precision (exact-amount payment). */
export function formatUsdcExact(micro: number): string {
  const usd = micro / 1e6;
  const magnitude = Math.abs(usd).toLocaleString("en-US", {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  });
  return `${usd < 0 ? "−" : ""}$${magnitude}`;
}

/** Signed variant with an explicit plus sign for gains. */
export function formatUsdcSigned(micro: number): string {
  return micro > 0 ? `+${formatUsdc(micro)}` : formatUsdc(micro);
}

/** Seconds → "m:ss" countdown label (never negative). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
