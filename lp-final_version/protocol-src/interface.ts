/**
 * Liquidity Hedge Protocol — ILhProtocol Interface
 *
 * The canonical interface for the protocol. Both off-chain emulator
 * and future on-chain implementations conform to this interface.
 *
 * Simplified from v1: no cover ratio, no RT position management.
 */

import {
  PoolState,
  PositionState,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
} from "./types";
import { PoolInitConfig } from "./config/templates";
import { BuyCertResult } from "./operations/certificates";
import { SettleResult } from "./operations/certificates";

// ---------------------------------------------------------------------------
// Parameter interfaces
// ---------------------------------------------------------------------------

export interface RegisterPositionParams {
  positionMint: string;
  entryPriceE6: number;
  lowerTick: number;
  upperTick: number;
  liquidity: bigint;
  entryValueE6: number;
}

export interface BuyCertParams {
  positionMint: string;
  templateId: number;
}

export interface RegimeParams {
  sigmaPpm: number;
  sigma7dPpm: number;
  stressFlag: boolean;
  carryBpsPerDay: number;
  ivRvRatio: number;
}

// ---------------------------------------------------------------------------
// ILhProtocol interface
// ---------------------------------------------------------------------------

export interface ILhProtocol {
  // ── Pool Management ─────────────────────────────────────────

  /** Initialize the USDC protection pool with governance parameters. */
  initPool(admin: string, config: PoolInitConfig): PoolState;

  /** Deposit USDC into the pool. Returns shares minted. */
  depositUsdc(depositor: string, amount: number): { shares: number };

  /** Withdraw USDC by burning shares. Guarded by utilization. */
  withdrawUsdc(withdrawer: string, shares: number): { usdcReturned: number };

  /** Read current pool state. */
  getPoolState(): PoolState | null;

  // ── Position Escrow ─────────────────────────────────────────

  /** Register and lock a CL position for hedging. */
  registerLockedPosition(
    owner: string,
    params: RegisterPositionParams,
  ): void;

  /** Release a position back to the owner (requires no active cert). */
  releasePosition(owner: string, positionMint: string): void;

  /** Read position state. */
  getPositionState(positionMint: string): PositionState | null;

  // ── Pricing & Regime ────────────────────────────────────────

  /** Create a product template. Admin only. */
  createTemplate(admin: string, template: TemplateConfig): void;

  /** Update the market regime snapshot. */
  updateRegimeSnapshot(authority: string, params: RegimeParams): RegimeSnapshot;

  /** Read current regime snapshot. */
  getRegimeSnapshot(): RegimeSnapshot | null;

  /** Read a template by ID. */
  getTemplate(templateId: number): TemplateConfig | null;

  // ── Certificates ────────────────────────────────────────────

  /**
   * Buy a corridor hedge certificate for a locked position.
   * Premium formula: max(P_floor, FV · m_vol − y · E[F])
   */
  buyCertificate(buyer: string, params: BuyCertParams): BuyCertResult;

  /**
   * Settle a certificate at/after expiry. Permissionless.
   * Computes corridor payoff and fee split.
   * @param nowTs - Optional override for current time (testing)
   */
  settleCertificate(
    settler: string,
    positionMint: string,
    settlementPriceE6: number,
    feesAccruedUsdc: number,
    nowTs?: number,
  ): SettleResult;

  /** Read certificate state. */
  getCertificateState(positionMint: string): CertificateState | null;
}
