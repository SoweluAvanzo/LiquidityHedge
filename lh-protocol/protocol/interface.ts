/**
 * ILhProtocol — the protocol interface that decouples consumers from implementation.
 *
 * Both the off-chain emulator (OffchainLhProtocol) and the on-chain adapter
 * (OnchainLhProtocol) implement this interface. Switching between them
 * requires only changing which implementation is instantiated — all callers
 * (demo scripts, risk service, operator service) depend only on this interface.
 *
 * Every method corresponds 1:1 to an on-chain instruction in lh_core:
 *   initPool            → initialize_pool
 *   depositUsdc         → deposit_usdc
 *   withdrawUsdc        → withdraw_usdc
 *   registerLockedPosition → register_locked_position
 *   releasePosition     → release_position
 *   createTemplate      → create_template
 *   updateRegimeSnapshot → update_regime_snapshot
 *   buyCertificate      → buy_certificate
 *   settleCertificate   → settle_certificate
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PoolState,
  PositionState,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
  RegisterPositionParams,
  TemplateParams,
  RegimeParams,
  BuyCertParams,
  BuyCertResult,
  SettleResult,
  PoolV2Config,
  RtPositionState,
  DepositRtResult,
  WithdrawRtResult,
  DepositLpAndHedgeResult,
  ReplacementRequest,
} from "./types";

export interface ILhProtocol {
  // ─── Pool Management ──────────────────────────────────────────

  /** Initialize the USDC protection pool. Can only be called once. */
  initPool(admin: Keypair, usdcMint: PublicKey, uMaxBps: number, v2Config?: PoolV2Config): Promise<void>;

  /** Deposit USDC into the pool. Returns shares minted (NAV-based pricing). */
  depositUsdc(depositor: Keypair, amount: number): Promise<{ shares: number }>;

  /** Withdraw USDC by burning shares. Guarded by utilization constraint. */
  withdrawUsdc(
    withdrawer: Keypair,
    shares: number
  ): Promise<{ usdcReturned: number }>;

  /** Read current pool state. */
  getPoolState(): Promise<PoolState>;

  // ─── Position Escrow ──────────────────────────────────────────

  /**
   * Register and lock an Orca position.
   * The position NFT must already be in the protocol's custody.
   * Validates Orca account data, Pyth entry price, and pool pair.
   */
  registerLockedPosition(
    owner: Keypair,
    params: RegisterPositionParams
  ): Promise<void>;

  /** Release a locked position back to the owner. Requires no active certificate. */
  releasePosition(owner: Keypair, positionMint: PublicKey): Promise<void>;

  /** Read position state by position mint. */
  getPositionState(positionMint: PublicKey): Promise<PositionState>;

  // ─── Pricing & Regime ─────────────────────────────────────────

  /** Create a certificate template with pricing parameters. Admin only. */
  createTemplate(admin: Keypair, params: TemplateParams): Promise<void>;

  /** Update the market regime snapshot (volatility, stress). Admin only. */
  updateRegimeSnapshot(
    authority: Keypair,
    params: RegimeParams
  ): Promise<void>;

  /** Read current regime snapshot. */
  getRegimeSnapshot(): Promise<RegimeSnapshot>;

  /** Read a template by ID. */
  getTemplate(templateId: number): Promise<TemplateConfig>;

  // ─── Certificates ─────────────────────────────────────────────

  /**
   * Buy a hedge certificate for a locked position.
   * Computes premium on-chain/off-chain, collects payment, activates certificate.
   */
  buyCertificate(
    buyer: Keypair,
    params: BuyCertParams
  ): Promise<BuyCertResult>;

  /**
   * Settle a certificate at/after expiry. Permissionless (anyone can call).
   * Reads Pyth price, computes payout, transfers USDC if due.
   */
  settleCertificate(
    settler: Keypair,
    positionMint: PublicKey
  ): Promise<SettleResult>;

  /** Read certificate state by position mint. */
  getCertificateState(positionMint: PublicKey): Promise<CertificateState>;

  // ─── v2: RT Position Management ──────────────────────────────

  /** RT deposits SOL + USDC; vault opens a wider Orca position on their behalf. */
  depositRt?(
    rt: Keypair,
    solAmount: number,
    usdcAmount: number,
    expiryTs: number,
    linkedCertMint?: string,
  ): Promise<DepositRtResult>;

  /** RT early withdrawal with penalty. Triggers replacement request. */
  withdrawRtEarly?(
    rt: Keypair,
    rtPositionMint: string,
  ): Promise<WithdrawRtResult>;

  /** RT withdrawal at/after expiry. Full deferred premium + fee share. */
  withdrawRtAtExpiry?(
    rt: Keypair,
    rtPositionMint: string,
  ): Promise<WithdrawRtResult>;

  /** Read RT position state. */
  getRtPositionState?(rtPositionMint: string): Promise<RtPositionState>;

  // ─── v2: LP Vault-Managed Position ───────────────────────────

  /** LP deposits SOL + USDC; vault opens position AND buys certificate. */
  depositLpAndHedge?(
    lp: Keypair,
    solAmount: number,
    usdcAmount: number,
    templateId: number,
    capUsdc: number,
    barrierPct: number,
    premiumTxSignature: string,
  ): Promise<DepositLpAndHedgeResult>;

  // ─── v2: Replacement RT ──────────────────────────────────────

  /** Fill a replacement request as a new RT. */
  fillReplacementRequest?(
    newRt: Keypair,
    certPositionMint: string,
    solAmount: number,
    usdcAmount: number,
  ): Promise<DepositRtResult & { bonusUsdc: number }>;

  /** List open replacement requests. */
  getReplacementRequests?(): Promise<ReplacementRequest[]>;
}
