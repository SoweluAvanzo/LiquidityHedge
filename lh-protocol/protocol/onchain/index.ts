/**
 * OnchainLhProtocol — on-chain adapter implementing ILhProtocol.
 *
 * Wraps the Anchor program calls for lh_core. This adapter becomes
 * functional once the program is deployed to Solana (devnet or mainnet).
 *
 * Currently a stub with method signatures matching the interface.
 * Each method will delegate to program.methods.* calls.
 *
 * To activate: deploy the program, then set PROTOCOL_MODE=onchain.
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

export class OnchainLhProtocol implements ILhProtocol {
  private connection: Connection;
  private program: any; // anchor.Program<LhCore>

  constructor(connection: Connection, program: any) {
    this.connection = connection;
    this.program = program;
  }

  // ─── Stub implementations ──────────────────────────────────────
  // Each method will be implemented when the program is deployed.
  // The method signatures match ILhProtocol exactly, ensuring
  // the swap from off-chain to on-chain is seamless.

  async initPool(admin: Keypair, usdcMint: PublicKey, uMaxBps: number): Promise<void> {
    throw new Error("OnchainLhProtocol: deploy program first, then implement initPool");
  }

  async depositUsdc(depositor: Keypair, amount: number): Promise<{ shares: number }> {
    throw new Error("OnchainLhProtocol: deploy program first, then implement depositUsdc");
  }

  async withdrawUsdc(withdrawer: Keypair, shares: number): Promise<{ usdcReturned: number }> {
    throw new Error("OnchainLhProtocol: deploy program first, then implement withdrawUsdc");
  }

  async getPoolState(): Promise<PoolState> {
    throw new Error("OnchainLhProtocol: deploy program first, then implement getPoolState");
  }

  async registerLockedPosition(owner: Keypair, params: RegisterPositionParams): Promise<void> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async releasePosition(owner: Keypair, positionMint: PublicKey): Promise<void> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async getPositionState(positionMint: PublicKey): Promise<PositionState> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async createTemplate(admin: Keypair, params: TemplateParams): Promise<void> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async updateRegimeSnapshot(authority: Keypair, params: RegimeParams): Promise<void> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async getRegimeSnapshot(): Promise<RegimeSnapshot> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async getTemplate(templateId: number): Promise<TemplateConfig> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async buyCertificate(buyer: Keypair, params: BuyCertParams): Promise<BuyCertResult> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async settleCertificate(settler: Keypair, positionMint: PublicKey): Promise<SettleResult> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }

  async getCertificateState(positionMint: PublicKey): Promise<CertificateState> {
    throw new Error("OnchainLhProtocol: deploy program first");
  }
}
