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
} from "../types";
import { PoolInitConfig } from "../config/templates";
import {
  ILhProtocol,
  RegisterPositionParams,
  BuyCertParams,
  RegimeParams,
} from "../external-interface/ilh-protocol";
import { StateStore } from "../event-audit/store";
import { AuditLogger } from "../event-audit/logger";
import type { ProtocolEvent } from "../event-audit/events";
import { initPool, depositUsdc, withdrawUsdc } from "../pool-manager/pool";
import {
  buyCertificate,
  settleCertificate,
  BuyCertResult,
  SettleResult,
} from "./certificates";
import { updateRegime } from "../risk-analyser/regime";

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { StateStore } from "../event-audit/store";
export { AuditLogger } from "../event-audit/logger";
export * from "../types";
export { ILhProtocol, RegisterPositionParams, RegimeParams } from "../external-interface/ilh-protocol";
export type { BuyCertParams as ILhBuyCertParams } from "../external-interface/ilh-protocol";
export * from "../pricing-engine/pricing";
export * from "../pool-manager/pool";
export { buyCertificate, settleCertificate, BuyCertParams, BuyCertResult, SettleResult } from "./certificates";
export * from "../risk-analyser/regime";
export * from "../utils/math";
export * from "../pricing-engine/position-value";
export * from "../config/templates";

// ---------------------------------------------------------------------------
// OffchainLhProtocol
// ---------------------------------------------------------------------------

export class OffchainLhProtocol implements ILhProtocol {
  private store: StateStore;
  private logger: AuditLogger;
  private events: ProtocolEvent[] = [];

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

  /**
   * Access typed protocol events. Parallel to the AuditLogger's
   * JSONL output — same content but strongly typed and filterable
   * by `event.type`. Will be replaced by on-chain Anchor events
   * when the program is deployed.
   */
  getEvents(): ProtocolEvent[] {
    return [...this.events];
  }

  private emit(e: ProtocolEvent): void {
    this.events.push(e);
  }

  // ── Pool Management ─────────────────────────────────────────

  initPool(admin: string, config: PoolInitConfig): PoolState {
    const pool = initPool(this.store, { ...config, admin });
    this.logger.logSuccess("initPool", { admin, ...config });
    this.emit({
      ts: new Date().toISOString(),
      component: "PoolManager",
      type: "PoolInitialized",
      admin,
      uMaxBps: config.uMaxBps,
      markupFloor: config.markupFloor,
      feeSplitRate: config.feeSplitRate,
      premiumFloorUsdc: config.premiumFloorUsdc,
      protocolFeeBps: config.protocolFeeBps,
    });
    return pool;
  }

  depositUsdc(depositor: string, amount: number): { shares: number } {
    const result = depositUsdc(this.store, depositor, amount);
    this.logger.logSuccess("depositUsdc", { depositor, amount }, {
      shares: result.shares,
      sharePriceBefore: result.sharePriceBefore,
      sharePriceAfter: result.sharePriceAfter,
    });
    this.emit({
      ts: new Date().toISOString(),
      component: "PoolManager",
      type: "RtDeposited",
      depositor,
      amountUsdc: amount,
      sharesIssued: result.shares,
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
    this.emit({
      ts: new Date().toISOString(),
      component: "PoolManager",
      type: "RtWithdrew",
      withdrawer,
      sharesBurned: shares,
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
    this.emit({
      ts: new Date().toISOString(),
      component: "PositionEscrow",
      type: "PositionRegistered",
      positionMint: params.positionMint,
      owner,
      entryPriceE6: params.entryPriceE6,
      entryValueE6: params.entryValueE6,
      lowerTick: params.lowerTick,
      upperTick: params.upperTick,
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
    this.emit({
      ts: new Date().toISOString(),
      component: "PositionEscrow",
      type: "PositionReleased",
      positionMint,
      owner,
    });
  }

  getPositionState(positionMint: string): PositionState | null {
    return this.store.getPosition(positionMint);
  }

  // ── Pricing & Regime ────────────────────────────────────────

  createTemplate(admin: string, template: TemplateConfig): void {
    this.store.addTemplate(template);
    this.logger.logSuccess("createTemplate", { admin, ...template });
    this.emit({
      ts: new Date().toISOString(),
      component: "PricingEngine",
      type: "TemplateCreated",
      admin,
      templateId: template.templateId,
      widthBps: template.widthBps,
      tenorSeconds: template.tenorSeconds,
    });
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
    this.emit({
      ts: new Date().toISOString(),
      component: "RiskAnalyser",
      type: "RegimeUpdated",
      authority,
      sigmaPpm: regime.sigmaPpm,
      sigma7dPpm: regime.sigma7dPpm,
      stressFlag: regime.stressFlag,
      carryBpsPerDay: regime.carryBpsPerDay,
      ivRvRatio: regime.ivRvRatio,
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
    this.emit({
      ts: new Date().toISOString(),
      component: "Orchestrator",
      type: "CertificateBought",
      buyer,
      positionMint: params.positionMint,
      templateId: params.templateId,
      premiumUsdc: result.premiumUsdc,
      capUsdc: result.capUsdc,
      barrierE6: result.barrierE6,
      effectiveMarkup: result.effectiveMarkup,
      fairValueUsdc: result.fairValueUsdc,
      feeDiscountUsdc: result.feeDiscountUsdc,
      protocolFeeUsdc: result.protocolFeeUsdc,
      expiryTs: result.expiryTs,
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
    this.emit({
      ts: new Date().toISOString(),
      component: "CertificateLifecycleManager",
      type: "CertificateSettled",
      settler,
      positionMint,
      payoutUsdc: result.payoutUsdc,
      rtFeeIncomeUsdc: result.rtFeeIncomeUsdc,
      settlementPriceE6: result.settlementPriceE6,
      feesAccruedUsdc: result.feesAccruedUsdc,
      state: result.state,
    });
    return result;
  }

  getCertificateState(positionMint: string): CertificateState | null {
    return this.store.getCertificate(positionMint);
  }
}
