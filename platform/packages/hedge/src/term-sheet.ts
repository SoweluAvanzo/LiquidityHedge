/**
 * Term-sheet generation (Master Terms Annex 1 / legal doc 03).
 * The canonical JSON is what gets hashed; the hash is shown pre-purchase,
 * stored in the quote, and anchored on-chain at activation (AR-6).
 */

import { createHash } from "crypto";
import { LedgerConfig, QuoteRecord } from "./types";

export interface TermSheet {
  documentType: "lh-certificate-term-sheet";
  version: "1";
  masterTermsVersion: string;
  masterTermsHash: string;
  quoteId: string;
  paymentReference: string;
  issuedAtTs: number;
  validUntilTs: number;
  buyerWallet: string;
  position: {
    positionMint: string;
    whirlpool: string;
    liquidity: string;
    tickLower: number;
    tickUpper: number;
  };
  economics: {
    entryPriceUsd: number;
    corridorLowerUsd: number;
    corridorUpperUsd: number;
    entryValueUsdc: number;
    premiumUsdc: number;
    collateralUsdc: number; // = capUp
    totalPayableUsdc: number;
    capDownUsdc: number;
    capUpUsdc: number;
    feeSplitRatePct: number;
    tenorSeconds: number;
    premiumBreakdown: QuoteRecord["breakdown"];
  };
  settlement: {
    formula: "payoff = V(S0) - V(clamp(ST, pL, pU)); paid = max(0, payoff - feeSplit + collateral)";
    pricePolicy: "Master Terms §7.1";
  };
  treasuryAddress: string;
}

export function buildTermSheet(quote: QuoteRecord, config: LedgerConfig): TermSheet {
  return {
    documentType: "lh-certificate-term-sheet",
    version: "1",
    masterTermsVersion: config.masterTermsVersion,
    masterTermsHash: config.masterTermsHash,
    quoteId: quote.quoteId,
    paymentReference: quote.referenceKey,
    issuedAtTs: quote.issuedAtTs,
    validUntilTs: quote.validUntilTs,
    buyerWallet: quote.position.ownerWallet,
    position: {
      positionMint: quote.position.positionMint,
      whirlpool: quote.position.whirlpool,
      liquidity: quote.position.liquidity,
      tickLower: quote.position.tickLower,
      tickUpper: quote.position.tickUpper,
    },
    economics: {
      entryPriceUsd: quote.entryPriceUsd,
      corridorLowerUsd: quote.priceLowerUsd,
      corridorUpperUsd: quote.priceUpperUsd,
      entryValueUsdc: quote.entryValueUsdc,
      premiumUsdc: quote.premiumUsdc,
      collateralUsdc: quote.capUpUsdc,
      totalPayableUsdc: quote.totalPayableUsdc,
      capDownUsdc: quote.capDownUsdc,
      capUpUsdc: quote.capUpUsdc,
      feeSplitRatePct: config.feeSplitRate * 100,
      tenorSeconds: config.tenorSeconds,
      premiumBreakdown: quote.breakdown,
    },
    settlement: {
      formula:
        "payoff = V(S0) - V(clamp(ST, pL, pU)); paid = max(0, payoff - feeSplit + collateral)",
      pricePolicy: "Master Terms §7.1",
    },
    treasuryAddress: config.treasuryAddress,
  };
}

/** Deterministic canonical JSON: keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function termSheetHash(sheet: TermSheet): string {
  return createHash("sha256").update(canonicalJson(sheet), "utf8").digest("hex");
}
