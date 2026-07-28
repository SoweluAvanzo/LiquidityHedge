/**
 * Hedge-module domain types. All money is integer µUSDC (safe below 2^53,
 * asserted at boundaries). All time is unix seconds via the injected Clock —
 * no Date.now() anywhere in domain logic (replayability, FR-S4/NFR-A1).
 */

export interface LedgerConfig {
  uMaxBps: number; //             3000 = 30%
  protocolFeeBps: number; //      150 = 1.5% (bookkeeping in v1: treasury = company)
  premiumFloorUsdc: number; //    1_500_000 = $1.50
  markupFloor: number; //         1.05
  feeSplitRate: number; //        0.10
  expectedDailyFee: number; //    0.005
  tenorSeconds: number; //        604_800 (7 days, Product A)
  quoteTtlSeconds: number; //     120 (Master Terms §4.1)
  regimeMaxAgeSeconds: number; // 900
  /** FR-H9 pilot cap: max Σ capDown of active certs per buyer wallet (0 = no cap). */
  perBuyerCapDownLimitUsdc: number;
  /**
   * A2 (anti-griefing): max simultaneously-open quotes per position owner.
   * Quoting is unauthenticated, and an open quote blocks re-quoting that
   * position, so without a cap an attacker could keep any LP permanently
   * unable to hedge for the cost of one request every two minutes.
   */
  maxOpenQuotesPerOwner: number;
  /**
   * A3 (anti-DoS): hard ceiling on lifetime quotes. The event log IS the
   * ledger and cannot be truncated, so unbounded quoting would grow the
   * log until boot-replay never completes. Reaching this is an operator
   * alert, not a normal condition.
   */
  maxLifetimeQuotes: number;
  masterTermsVersion: string;
  masterTermsHash: string;
  treasuryAddress: string;
}

/** The position being hedged, as discovered/decoded by @lh/portfolio. */
export interface HedgedPositionInput {
  positionMint: string;
  ownerWallet: string;
  whirlpool: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  decimalsA: number;
  decimalsB: number;
  /** Live pool price at quote time (token B per token A, human units). */
  currentPriceUsd: number;
}

export interface MarketInputs {
  /** Annualized realized vol (e.g. 0.62). */
  sigmaAnnual: number;
  /** IV/RV ratio; effectiveMarkup = max(markupFloor, ivRvRatio). */
  ivRvRatio: number;
  /** When the regime snapshot was computed — quote refuses if stale. */
  regimeUpdatedAtTs: number;
}

export type QuoteStatus = "open" | "lapsed" | "consumed";
export type CertStatus = "active" | "settled" | "expired";

export interface QuoteRecord {
  quoteId: string;
  referenceKey: string;
  position: Omit<HedgedPositionInput, "liquidity"> & { liquidity: string };
  priceLowerUsd: number;
  priceUpperUsd: number;
  entryPriceUsd: number;
  entryValueUsdc: number;
  premiumUsdc: number;
  capDownUsdc: number;
  capUpUsdc: number; // = required collateral
  totalPayableUsdc: number; // premium + collateral
  protocolFeeUsdc: number;
  breakdown: {
    fairValueUsdc: number;
    effectiveMarkup: number;
    feeDiscountUsdc: number;
    premiumFloorUsdc: number;
    sigmaAnnual: number;
  };
  termSheetHash: string;
  issuedAtTs: number;
  validUntilTs: number;
  status: QuoteStatus;
}

export interface PaymentRecord {
  /** On-chain transaction signature — the idempotency key. */
  txSignature: string;
  referenceKey: string;
  senderWallet: string;
  amountUsdc: number;
  observedAtTs: number;
  /** Consumed by activation or refund. */
  matched: boolean;
}

export interface CertificateRecord {
  quoteId: string;
  positionMint: string;
  buyerWallet: string;
  premiumUsdc: number;
  capDownUsdc: number;
  capUpUsdc: number;
  activatedAtTs: number;
  expiryTs: number;
  status: CertStatus;
  /**
   * The position's fee-growth-inside accumulators and liquidity AT
   * ACTIVATION.
   *
   * The Risk Taker's share is y x the fees accrued DURING the
   * certificate, so settlement needs the accumulator value at t0. It
   * cannot be recovered afterwards: the counter exists on-chain only at
   * the instant it is read. Absent (older certificates, or an unreadable
   * position) means the fee share cannot be computed and settlement must
   * fall back to zero, buyer-favourably.
   */
  feeCheckpoint?: FeeCheckpoint;
  settlement?: SettlementRecord;
}

/** u128 values as decimal strings — JSON-safe, lossless. */
export interface FeeCheckpoint {
  feeGrowthInsideA: string;
  feeGrowthInsideB: string;
  liquidity: string;
  decimalsA: number;
  decimalsB: number;
  takenAtTs: number;
}

export interface SettlementRecord {
  settlementPriceUsd: number;
  payoffUsdc: number; // signed, clamped to [−capUp, +capDown]
  feeSplitUsdc: number;
  /** Paid to buyer: max(0, payoff − feeSplit + collateral). Master Terms §7.2. */
  settlementAmountUsdc: number;
  settledAtTs: number;
}

export interface LedgerState {
  paused: boolean;
  initialReservesUsdc: number;
  /** Mirror of the treasury wallet balance. */
  treasuryUsdc: number;
  // Audit ledger (E13: inflows recorded at OBSERVATION time):
  totalInUsdc: number;
  totalSettledUsdc: number;
  totalRefundedUsdc: number;
  quotes: Map<string, QuoteRecord>;
  paymentsByTx: Map<string, PaymentRecord>;
  certs: Map<string, CertificateRecord>; // by quoteId — the 1:1 mapping IS the design
}

// ── Ports (chain access is never direct — AR-1) ─────────────────────

export interface Clock {
  now(): number;
}

/** Finalized inbound USDC transfer to the treasury, as seen on-chain. */
export interface ObservedTransfer {
  txSignature: string;
  referenceKey: string;
  senderWallet: string;
  amountUsdc: number;
}

/** Settlement price policy output (AR-7) — deterministic and archived. */
export interface SettlementPriceReading {
  priceUsd: number;
  slot: number;
  crossCheckPriceUsd: number;
  divergenceBps: number;
  /**
   * C2: where the cross-check came from. "unavailable" is only ever
   * paired with a sentinel divergence that forces deferral — a reading
   * asserting agreement with a source that was never consulted must be
   * unrepresentable in the archive.
   */
  crossCheckSource?: "birdeye" | "unavailable";
}

export class LedgerError extends Error {}
export class InvariantViolation extends Error {}

export function assertUsdcInt(x: number, label: string): void {
  if (!Number.isSafeInteger(x) || x < 0) {
    throw new LedgerError(`${label} must be a non-negative safe integer µUSDC, got ${x}`);
  }
}
