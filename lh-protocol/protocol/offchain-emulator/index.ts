/**
 * OffchainLhProtocol — off-chain emulator implementing ILhProtocol.
 *
 * Replicates every on-chain instruction with identical validation,
 * pricing, and state management. Uses real Solana SPL transfers,
 * real Pyth oracle reads, and real Orca account parsing.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ILhProtocol } from "../interface";
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
} from "../types";
import { StateStore } from "./state/store";
import { AuditLogger } from "./audit/logger";
import * as poolOps from "./operations/pool";
import * as escrowOps from "./operations/escrow";
import * as certOps from "./operations/certificates";

export class OffchainLhProtocol implements ILhProtocol {
  private store: StateStore;
  private logger: AuditLogger;
  private connection: Connection;
  private vaultKeypair: Keypair;

  constructor(connection: Connection, vaultKeypair: Keypair, dataDir: string) {
    this.connection = connection;
    this.vaultKeypair = vaultKeypair;
    this.store = new StateStore(dataDir);
    this.logger = new AuditLogger(dataDir);
  }

  getVaultPublicKey(): PublicKey {
    return this.vaultKeypair.publicKey;
  }

  // ─── Pool ──────────────────────────────────────────────────────

  async initPool(
    admin: Keypair,
    usdcMint: PublicKey,
    uMaxBps: number
  ): Promise<void> {
    await poolOps.initPool(
      this.store, this.logger, this.connection,
      this.vaultKeypair, admin, usdcMint, uMaxBps
    );
  }

  async depositUsdc(
    depositor: Keypair,
    amount: number,
    txSignature?: string
  ): Promise<{ shares: number }> {
    if (!txSignature) {
      throw new Error(
        "Off-chain mode requires txSignature: send USDC to vault first, then pass the tx sig"
      );
    }
    return poolOps.depositUsdc(
      this.store, this.logger, this.connection,
      depositor, amount, txSignature
    );
  }

  async withdrawUsdc(
    withdrawer: Keypair,
    shares: number
  ): Promise<{ usdcReturned: number }> {
    return poolOps.withdrawUsdc(
      this.store, this.logger, this.connection,
      this.vaultKeypair, withdrawer, shares
    );
  }

  async getPoolState(): Promise<PoolState> {
    const pool = this.store.getPool();
    if (!pool) throw new Error("Pool not initialized");
    return pool;
  }

  // ─── Position Escrow ───────────────────────────────────────────

  async registerLockedPosition(
    owner: Keypair,
    params: RegisterPositionParams
  ): Promise<void> {
    await escrowOps.registerLockedPosition(
      this.store, this.logger, this.connection,
      this.vaultKeypair, owner, params
    );
  }

  async releasePosition(
    owner: Keypair,
    positionMint: PublicKey
  ): Promise<void> {
    await escrowOps.releasePosition(
      this.store, this.logger, this.connection,
      this.vaultKeypair, owner, positionMint
    );
  }

  async getPositionState(positionMint: PublicKey): Promise<PositionState> {
    const pos = this.store.getPosition(positionMint.toBase58());
    if (!pos) throw new Error(`Position not found: ${positionMint.toBase58()}`);
    return pos;
  }

  // ─── Pricing & Regime ──────────────────────────────────────────

  async createTemplate(
    admin: Keypair,
    params: TemplateParams
  ): Promise<void> {
    const pool = this.store.getPool();
    if (!pool) throw new Error("Pool not initialized");
    if (pool.admin !== admin.publicKey.toBase58()) throw new Error("Unauthorized");
    if (params.tenorSeconds < 60) throw new Error("InvalidTemplate: tenor < 60s");
    if (params.widthBps <= 0) throw new Error("InvalidTemplate: widthBps <= 0");
    if (params.severityPpm > 1_000_000) throw new Error("InvalidTemplate: severity > PPM");
    if (params.premiumFloorUsdc > params.premiumCeilingUsdc) {
      throw new Error("InvalidTemplate: floor > ceiling");
    }

    this.store.addTemplate({ ...params, active: true });
    this.logger.logOperation(
      "createTemplate",
      params,
      this.store.getVersion()
    );
  }

  async updateRegimeSnapshot(
    authority: Keypair,
    params: RegimeParams
  ): Promise<void> {
    const pool = this.store.getPool();
    if (!pool) throw new Error("Pool not initialized");
    if (pool.admin !== authority.publicKey.toBase58()) throw new Error("Unauthorized");

    // Bounds validation (from our hardening)
    if (params.sigmaPpm < 1_000 || params.sigmaPpm > 5_000_000) {
      throw new Error("InvalidRegimeParams: sigma out of range");
    }
    if (params.sigmaMaPpm < 1_000 || params.sigmaMaPpm > 5_000_000) {
      throw new Error("InvalidRegimeParams: sigmaMa out of range");
    }
    if (params.carryBpsPerDay > 1_000) {
      throw new Error("InvalidRegimeParams: carry > 1000");
    }

    this.store.setRegime({
      ...params,
      updatedTs: Math.floor(Date.now() / 1000),
      signer: authority.publicKey.toBase58(),
    });
    this.logger.logOperation(
      "updateRegimeSnapshot",
      params,
      this.store.getVersion()
    );
  }

  async getRegimeSnapshot(): Promise<RegimeSnapshot> {
    const regime = this.store.getRegime();
    if (!regime) throw new Error("Regime not initialized");
    return regime;
  }

  async getTemplate(templateId: number): Promise<TemplateConfig> {
    const t = this.store.getTemplate(templateId);
    if (!t) throw new Error(`Template not found: ${templateId}`);
    return t;
  }

  // ─── Certificates ──────────────────────────────────────────────

  async buyCertificate(
    buyer: Keypair,
    params: BuyCertParams,
    premiumTxSignature?: string
  ): Promise<BuyCertResult> {
    if (!premiumTxSignature) {
      throw new Error(
        "Off-chain mode requires premiumTxSignature: send premium USDC to vault first"
      );
    }
    return certOps.buyCertificate(
      this.store, this.logger, this.connection,
      buyer, params, premiumTxSignature
    );
  }

  async settleCertificate(
    settler: Keypair,
    positionMint: PublicKey
  ): Promise<SettleResult> {
    return certOps.settleCertificate(
      this.store, this.logger, this.connection,
      this.vaultKeypair, settler, positionMint
    );
  }

  async getCertificateState(positionMint: PublicKey): Promise<CertificateState> {
    const cert = this.store.getCertificate(positionMint.toBase58());
    if (!cert) throw new Error(`Certificate not found: ${positionMint.toBase58()}`);
    return cert;
  }
}
