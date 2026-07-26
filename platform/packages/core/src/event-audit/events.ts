/**
 * Typed event schemas for every state change in the protocol.
 *
 * These are the structured shapes of audit log entries' `details`
 * payloads. When the on-chain Anchor program ships, each type here
 * will have a 1:1 counterpart in `programs/lh-core/src/events.rs`,
 * so tests and observers can share a vocabulary across the
 * off-chain/on-chain boundary.
 *
 * Every event carries the emitting component name so audit consumers
 * can filter by component without parsing opaque operation strings.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export type ProtocolComponent =
  | "Orchestrator"
  | "RiskAnalyser"
  | "PricingEngine"
  | "PositionEscrow"
  | "PoolManager"
  | "CertificateLifecycleManager"
  | "MarketDataService"
  | "ExternalInterface";

export interface BaseEvent {
  /** ISO-8601 event time (same as AuditEntry.timestamp, duplicated here for schema-self-containment). */
  ts: string;
  /** The component that emitted this event. */
  component: ProtocolComponent;
}

// ---------------------------------------------------------------------------
// Pool Manager
// ---------------------------------------------------------------------------

export interface PoolInitializedEvent extends BaseEvent {
  type: "PoolInitialized";
  admin: string;
  uMaxBps: number;
  markupFloor: number;
  feeSplitRate: number;
  premiumFloorUsdc: number;
  protocolFeeBps: number;
}

export interface RtDepositedEvent extends BaseEvent {
  type: "RtDeposited";
  depositor: string;
  amountUsdc: number;
  sharesIssued: number;
  sharePriceBefore: number;
  sharePriceAfter: number;
}

export interface RtWithdrewEvent extends BaseEvent {
  type: "RtWithdrew";
  withdrawer: string;
  sharesBurned: number;
  usdcReturned: number;
  sharePriceBefore: number;
  sharePriceAfter: number;
}

// ---------------------------------------------------------------------------
// Position Escrow
// ---------------------------------------------------------------------------

export interface PositionRegisteredEvent extends BaseEvent {
  type: "PositionRegistered";
  positionMint: string;
  owner: string;
  entryPriceE6: number;
  entryValueE6: number;
  lowerTick: number;
  upperTick: number;
}

export interface PositionReleasedEvent extends BaseEvent {
  type: "PositionReleased";
  positionMint: string;
  owner: string;
}

// ---------------------------------------------------------------------------
// Risk Analyser
// ---------------------------------------------------------------------------

export interface RegimeUpdatedEvent extends BaseEvent {
  type: "RegimeUpdated";
  authority: string;
  sigmaPpm: number;
  sigma7dPpm: number;
  stressFlag: boolean;
  carryBpsPerDay: number;
  ivRvRatio: number;
  effectiveMarkup: number;
  severityPpm: number;
}

// ---------------------------------------------------------------------------
// Pricing Engine + Orchestrator: certificate lifecycle
// ---------------------------------------------------------------------------

export interface TemplateCreatedEvent extends BaseEvent {
  type: "TemplateCreated";
  admin: string;
  templateId: number;
  widthBps: number;
  tenorSeconds: number;
}

export interface CertificateBoughtEvent extends BaseEvent {
  type: "CertificateBought";
  buyer: string;
  positionMint: string;
  templateId: number;
  premiumUsdc: number;
  capUsdc: number;
  barrierE6: number;
  effectiveMarkup: number;
  fairValueUsdc: number;
  feeDiscountUsdc: number;
  protocolFeeUsdc: number;
  expiryTs: number;
}

export interface CertificateSettledEvent extends BaseEvent {
  type: "CertificateSettled";
  settler: string;
  positionMint: string;
  /** Signed payout: + = RT→LP, − = LP→RT. */
  payoutUsdc: number;
  rtFeeIncomeUsdc: number;
  settlementPriceE6: number;
  feesAccruedUsdc: number;
  /** 2 = Settled, 3 = Expired (measure-zero S_T = S_0). */
  state: number;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type ProtocolEvent =
  | PoolInitializedEvent
  | RtDepositedEvent
  | RtWithdrewEvent
  | PositionRegisteredEvent
  | PositionReleasedEvent
  | RegimeUpdatedEvent
  | TemplateCreatedEvent
  | CertificateBoughtEvent
  | CertificateSettledEvent;

// ---------------------------------------------------------------------------
// Type guards (useful in tests and event-driven consumers)
// ---------------------------------------------------------------------------

export function isCertificateBought(
  e: ProtocolEvent,
): e is CertificateBoughtEvent {
  return e.type === "CertificateBought";
}

export function isCertificateSettled(
  e: ProtocolEvent,
): e is CertificateSettledEvent {
  return e.type === "CertificateSettled";
}

export function isRegimeUpdated(e: ProtocolEvent): e is RegimeUpdatedEvent {
  return e.type === "RegimeUpdated";
}
