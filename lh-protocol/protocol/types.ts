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

// ─── Operation Result Types ──────────────────────────────────────────

export interface BuyCertResult {
  premiumUsdc: number;
  capUsdc: number;
  expiryTs: number;
}

export interface SettleResult {
  payout: number;
  state: number; // CertStatus.SETTLED or CertStatus.EXPIRED
  settlementPriceE6: number;
  conservativePriceE6: number;
}
