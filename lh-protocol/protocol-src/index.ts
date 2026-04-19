/**
 * Liquidity Hedge Protocol — Off-Chain Emulator
 *
 * OffchainLhProtocol implements the ILhProtocol interface using
 * in-memory state with optional JSON persistence and audit logging.
 */

import {
  PoolState,
  PositionState,
  PositionStatus,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
} from "./types";
import { PoolInitConfig } from "./config/templates";
import {
  ILhProtocol,
  RegisterPositionParams,
  BuyCertParams,
  RegimeParams,
} from "./interface";
import { StateStore } from "./state/store";
import { AuditLogger } from "./audit/logger";
import { initPool, depositUsdc, withdrawUsdc } from "./operations/pool";
import {
  buyCertificate,
  settleCertificate,
  BuyCertResult,
  SettleResult,
} from "./operations/certificates";
import { updateRegime } from "./operations/regime";

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { StateStore } from "./state/store";
export { AuditLogger } from "./audit/logger";
export * from "./types";
export { ILhProtocol, RegisterPositionParams, RegimeParams } from "./interface";
export type { BuyCertParams as ILhBuyCertParams } from "./interface";
export * from "./operations/pricing";
export * from "./operations/pool";
export { buyCertificate, settleCertificate, BuyCertParams, BuyCertResult, SettleResult } from "./operations/certificates";
export * from "./operations/regime";
export * from "./utils/math";
export * from "./utils/position-value";
export * from "./config/templates";

// ---------------------------------------------------------------------------
// OffchainLhProtocol
// ---------------------------------------------------------------------------

export class OffchainLhProtocol implements ILhProtocol {
  private store: StateStore;
  private logger: AuditLogger;

  constructor(dataDir?: string) {
    this.store = new StateStore(dataDir);
    this.logger = new AuditLogger(dataDir);
  }

  /** Access the underlying state store (for testing). */
  getStore(): StateStore {
    return this.store;
  }

  /** Access the audit logger (for testing). */
  getLogger(): AuditLogger {
    return this.logger;
  }

  // ── Pool Management ─────────────────────────────────────────

  initPool(admin: string, config: PoolInitConfig): PoolState {
    const pool = initPool(this.store, { ...config, admin });
    this.logger.logSuccess("initPool", { admin, ...config });
    return pool;
  }

  depositUsdc(depositor: string, amount: number): { shares: number } {
    const result = depositUsdc(this.store, depositor, amount);
    this.logger.logSuccess("depositUsdc", { depositor, amount }, {
      shares: result.shares,
      sharePriceBefore: result.sharePriceBefore,
      sharePriceAfter: result.sharePriceAfter,
    });
    return { shares: result.shares };
  }

  withdrawUsdc(withdrawer: string, shares: number): { usdcReturned: number } {
    const result = withdrawUsdc(this.store, withdrawer, shares);
    this.logger.logSuccess("withdrawUsdc", { withdrawer, shares }, {
      usdcReturned: result.usdcReturned,
      sharePriceBefore: result.sharePriceBefore,
      sharePriceAfter: result.sharePriceAfter,
    });
    return { usdcReturned: result.usdcReturned };
  }

  getPoolState(): PoolState | null {
    return this.store.getPool();
  }

  // ── Position Escrow ─────────────────────────────────────────

  registerLockedPosition(
    owner: string,
    params: RegisterPositionParams,
  ): void {
    const position: PositionState = {
      positionMint: params.positionMint,
      owner,
      entryPriceE6: params.entryPriceE6,
      lowerTick: params.lowerTick,
      upperTick: params.upperTick,
      liquidity: params.liquidity,
      entryValueE6: params.entryValueE6,
      status: PositionStatus.Locked,
      protectedBy: null,
      bump: 255,
    };
    this.store.addPosition(position);
    this.logger.logSuccess("registerLockedPosition", {
      owner,
      positionMint: params.positionMint,
      entryPriceE6: params.entryPriceE6,
    });
  }

  releasePosition(owner: string, positionMint: string): void {
    const pos = this.store.getPosition(positionMint);
    if (!pos) throw new Error(`Position ${positionMint} not found`);
    if (pos.owner !== owner) throw new Error("Not the position owner");
    if (pos.protectedBy) {
      throw new Error("Cannot release: position is protected by a certificate");
    }
    if (pos.status !== PositionStatus.Locked) {
      throw new Error("Position is not locked");
    }

    this.store.updatePosition(positionMint, (p) => {
      p.status = PositionStatus.Released;
    });
    this.logger.logSuccess("releasePosition", { owner, positionMint });
  }

  getPositionState(positionMint: string): PositionState | null {
    return this.store.getPosition(positionMint);
  }

  // ── Pricing & Regime ────────────────────────────────────────

  createTemplate(admin: string, template: TemplateConfig): void {
    this.store.addTemplate(template);
    this.logger.logSuccess("createTemplate", { admin, ...template });
  }

  updateRegimeSnapshot(
    authority: string,
    params: RegimeParams,
  ): RegimeSnapshot {
    const regime = updateRegime(this.store, params, authority);
    this.logger.logSuccess("updateRegimeSnapshot", { authority, ...params }, {
      effectiveMarkup: regime.effectiveMarkup,
      severityPpm: regime.severityPpm,
    });
    return regime;
  }

  getRegimeSnapshot(): RegimeSnapshot | null {
    return this.store.getRegime();
  }

  getTemplate(templateId: number): TemplateConfig | null {
    return this.store.getTemplate(templateId);
  }

  // ── Certificates ────────────────────────────────────────────

  buyCertificate(buyer: string, params: BuyCertParams): BuyCertResult {
    const result = buyCertificate(this.store, buyer, {
      positionMint: params.positionMint,
      templateId: params.templateId,
    });
    this.logger.logSuccess("buyCertificate", { buyer, ...params }, {
      premiumUsdc: result.premiumUsdc,
      capUsdc: result.capUsdc,
      barrierE6: result.barrierE6,
      effectiveMarkup: result.effectiveMarkup,
    });
    return result;
  }

  settleCertificate(
    settler: string,
    positionMint: string,
    settlementPriceE6: number,
    feesAccruedUsdc: number,
    nowTs?: number,
  ): SettleResult {
    const result = settleCertificate(
      this.store,
      positionMint,
      settlementPriceE6,
      feesAccruedUsdc,
      nowTs,
    );
    this.logger.logSuccess(
      "settleCertificate",
      { settler, positionMint, settlementPriceE6, feesAccruedUsdc },
      {
        payoutUsdc: result.payoutUsdc,
        rtFeeIncomeUsdc: result.rtFeeIncomeUsdc,
        state: result.state,
      },
    );
    return result;
  }

  getCertificateState(positionMint: string): CertificateState | null {
    return this.store.getCertificate(positionMint);
  }
}
