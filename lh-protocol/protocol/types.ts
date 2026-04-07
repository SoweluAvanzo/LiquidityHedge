/**
 * Shared types for the Liquidity Hedge Protocol.
 *
 * These types mirror the on-chain Rust state definitions in
 * programs/lh-core/src/state.rs EXACTLY. Both the off-chain emulator
 * and the on-chain adapter use these same types, ensuring 1:1
 * correspondence and enabling seamless swapping.
 */

import { Keypair, PublicKey } from "@solana/web3.js";

// ─── Status Constants (from state.rs) ────────────────────────────────

export const PositionStatus = {
  LOCKED: 1,
  RELEASED: 2,
  CLOSED: 3,
} as const;

export const CertStatus = {
  CREATED: 0,
  ACTIVE: 1,
  SETTLED: 2,
  EXPIRED: 3,
} as const;

export const RtPositionStatus = {
  ACTIVE: 1,
  EXITED_EARLY: 2,
  EXITED_AT_EXPIRY: 3,
  REPLACED: 4,
} as const;

// ─── Protocol Constants (from constants.rs) ──────────────────────────

export const PPM = 1_000_000; // parts per million
export const BPS = 10_000; // basis points
export const PYTH_MAX_STALENESS_S = 30;
export const ENTRY_PRICE_TOLERANCE_PPM = 50_000; // 5%
export const PYTH_MAX_CONFIDENCE_PPM = 50_000; // 5%
export const REGIME_MAX_AGE_S = 900; // 15 minutes

// ─── State Types (mirror state.rs) ───────────────────────────────────

export interface PoolState {
  admin: string; // base58 pubkey
  usdcMint: string;
  usdcVault: string; // vault ATA address
  reservesUsdc: number; // micro-USDC (u64)
  activeCapUsdc: number;
  totalShares: number;
  uMaxBps: number;
  // v2: premium and fee configuration (optional, defaults = v1 behavior)
  premiumUpfrontBps?: number;     // default 10000 = 100% upfront
  feeShareMinBps?: number;        // default 0 = no fee sharing
  feeShareMaxBps?: number;        // default 0
  earlyExitPenaltyBps?: number;   // default 0 = no penalty
  rtTickWidthMultiplier?: number; // default 2 = RT gets 2x LP tick width
}

export interface PositionState {
  owner: string;
  whirlpool: string;
  positionMint: string;
  lowerTick: number;
  upperTick: number;
  p0PriceE6: number;
  oracleP0E6: number;
  depositedA: number; // lamports
  depositedB: number; // micro-USDC
  liquidity: string; // bigint as string for JSON serialization
  protectedBy: string | null; // positionMint of cert, or null
  status: number; // PositionStatus
}

export interface CertificateState {
  owner: string;
  positionMint: string; // identifies both position and certificate
  pool: string;
  templateId: number;
  premiumUsdc: number;
  capUsdc: number;
  lowerBarrierE6: number;
  notionalUsdc: number;
  expiryTs: number; // unix seconds
  state: number; // CertStatus
  nftMint: string;
  // v2: split premium and fee sharing (optional)
  premiumUpfrontUsdc?: number;
  premiumDeferredUsdc?: number;
  rtPositionMint?: string | null;
  feeShareBps?: number;
  collectedFeesA?: number;   // SOL fees collected at settlement (lamports)
  collectedFeesB?: number;   // USDC fees collected at settlement (micro-USDC)
}

export interface RegimeSnapshot {
  sigmaPpm: number;
  sigmaMaPpm: number;
  stressFlag: boolean;
  carryBpsPerDay: number;
  updatedTs: number; // unix seconds
  signer: string;
}

export interface TemplateConfig {
  templateId: number;
  tenorSeconds: number;
  widthBps: number;
  severityPpm: number;
  premiumFloorUsdc: number;
  premiumCeilingUsdc: number;
  active: boolean;
}

// ─── v2 State Types ─────────────────────────────────────────────────

/** RT's vault-managed Orca position (v2). */
export interface RtPositionState {
  rtOwner: string;
  positionMint: string;
  whirlpool: string;
  lowerTick: number;
  upperTick: number;
  liquidity: string;              // bigint as string
  depositedSol: number;           // lamports
  depositedUsdc: number;          // micro-USDC
  entryPriceE6: number;
  depositTs: number;              // unix seconds
  expiryTs: number;
  linkedLpPositionMint: string | null;
  status: number;                 // RtPositionStatus
  earlyExitPenaltyPaid: number;   // micro-USDC, 0 if active or exited at expiry
}

/** Deferred premium held in escrow until settlement (v2). */
export interface PremiumEscrow {
  rtOwner: string;
  certPositionMint: string;
  deferredAmountUsdc: number;     // total deferred premium
  accruedAmountUsdc: number;      // earned so far (time-proportional)
  depositTs: number;
  expiryTs: number;
  released: boolean;
}

/** Request for a replacement RT after early exit (v2). */
export interface ReplacementRequest {
  certPositionMint: string;
  requiredSol: number;
  requiredUsdc: number;
  penaltyFundsUsdc: number;       // bonus from exiting RT
  createdTs: number;
  expiryTs: number;               // cert expiry — deadline
  status: "open" | "filled" | "expired";
}

// ─── Quote Breakdown (from pricing/instructions.rs) ──────────────────

export interface QuoteBreakdown {
  premiumUsdc: number;
  capUsdc: number;
  expectedPayoutUsdc: number;
  capitalChargeUsdc: number;
  adverseSelectionUsdc: number;
  replicationCostUsdc: number;
}

// ─── Operation Parameter Types ───────────────────────────────────────

export interface RegisterPositionParams {
  positionMint: PublicKey;
  whirlpool: PublicKey;
  p0PriceE6: number;
  depositedA: number;
  depositedB: number;
  lowerTick: number;
  upperTick: number;
  pythFeed: PublicKey;
}

export interface TemplateParams {
  templateId: number;
  tenorSeconds: number;
  widthBps: number;
  severityPpm: number;
  premiumFloorUsdc: number;
  premiumCeilingUsdc: number;
}

export interface RegimeParams {
  sigmaPpm: number;
  sigmaMaPpm: number;
  stressFlag: boolean;
  carryBpsPerDay: number;
}

export interface BuyCertParams {
  positionMint: PublicKey;
  templateId: number;
  capUsdc: number;
  lowerBarrierE6: number;
  notionalUsdc: number;
}

// ─── v2 Operation Parameter Types ────────────────────────────────────

export interface PoolV2Config {
  premiumUpfrontBps?: number;
  feeShareMinBps?: number;
  feeShareMaxBps?: number;
  earlyExitPenaltyBps?: number;
  rtTickWidthMultiplier?: number;
}

export interface DepositRtParams {
  solAmount: number;              // lamports
  usdcAmount: number;             // micro-USDC
  linkedCertMint?: PublicKey;
  expiryTs: number;               // lock-up end
}

export interface DepositLpAndHedgeParams {
  solAmount: number;              // lamports
  usdcAmount: number;             // micro-USDC
  templateId: number;
  capUsdc: number;
  barrierPct: number;             // e.g. 0.95
}

// ─── Operation Result Types ──────────────────────────────────────────

export interface BuyCertResult {
  premiumUsdc: number;
  capUsdc: number;
  expiryTs: number;
  premiumUpfrontUsdc?: number;
  premiumDeferredUsdc?: number;
}

export interface SettleResult {
  payout: number;
  state: number; // CertStatus.SETTLED or CertStatus.EXPIRED
  settlementPriceE6: number;
  conservativePriceE6: number;
  collectedFeesA?: number;
  collectedFeesB?: number;
  deferredPremiumReleased?: number;
}

export interface DepositRtResult {
  rtPositionMint: string;
  lowerTick: number;
  upperTick: number;
  liquidity: string;
  actualSol: number;
  actualUsdc: number;
}

export interface WithdrawRtResult {
  returnedSol: number;
  returnedUsdc: number;
  penaltyUsdc: number;
  deferredPremiumEarned: number;
  deferredPremiumForfeited: number;
  feeShareA: number;
  feeShareB: number;
  replacementRequestCreated: boolean;
}

export interface DepositLpAndHedgeResult {
  positionMint: string;
  certResult: BuyCertResult;
  lowerTick: number;
  upperTick: number;
  liquidity: string;
}
