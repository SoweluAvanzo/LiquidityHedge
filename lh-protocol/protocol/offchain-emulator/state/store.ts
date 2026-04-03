/**
 * JSON file persistence for protocol state.
 * Atomic writes via temp file + rename. Version counter for concurrency.
 */

import * as fs from "fs";
import * as path from "path";
import {
  PoolState,
  PositionState,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
} from "../../types";

export interface ProtocolState {
  version: number;
  pool: PoolState | null;
  regime: RegimeSnapshot | null;
  templates: TemplateConfig[];
  positions: PositionState[];
  certificates: CertificateState[];
  shareLedger: Record<string, number>; // address → share balance
  processedTxSigs: string[]; // anti-replay
}

function emptyState(): ProtocolState {
  return {
    version: 0,
    pool: null,
    regime: null,
    templates: [],
    positions: [],
    certificates: [],
    shareLedger: {},
    processedTxSigs: [],
  };
}

export class StateStore {
  private filePath: string;
  private state: ProtocolState;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "protocol-state.json");
    this.state = this.load();
  }

  private load(): ProtocolState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as ProtocolState;
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    this.state.version++;
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath); // atomic on Linux
  }

  get(): ProtocolState {
    return this.state;
  }

  getVersion(): number {
    return this.state.version;
  }

  // ─── Pool ──────────────────────────────────────────────────────

  getPool(): PoolState | null {
    return this.state.pool;
  }

  setPool(pool: PoolState): void {
    this.state.pool = pool;
    this.save();
  }

  updatePool(updater: (pool: PoolState) => void): void {
    if (!this.state.pool) throw new Error("Pool not initialized");
    updater(this.state.pool);
    this.save();
  }

  // ─── Regime ────────────────────────────────────────────────────

  getRegime(): RegimeSnapshot | null {
    return this.state.regime;
  }

  setRegime(regime: RegimeSnapshot): void {
    this.state.regime = regime;
    this.save();
  }

  // ─── Templates ─────────────────────────────────────────────────

  getTemplate(id: number): TemplateConfig | undefined {
    return this.state.templates.find((t) => t.templateId === id);
  }

  addTemplate(template: TemplateConfig): void {
    if (this.getTemplate(template.templateId)) {
      throw new Error(`Template ${template.templateId} already exists`);
    }
    this.state.templates.push(template);
    this.save();
  }

  // ─── Positions ─────────────────────────────────────────────────

  getPosition(positionMint: string): PositionState | undefined {
    return this.state.positions.find((p) => p.positionMint === positionMint);
  }

  addPosition(position: PositionState): void {
    this.state.positions.push(position);
    this.save();
  }

  updatePosition(
    positionMint: string,
    updater: (pos: PositionState) => void
  ): void {
    const pos = this.getPosition(positionMint);
    if (!pos) throw new Error(`Position not found: ${positionMint}`);
    updater(pos);
    this.save();
  }

  // ─── Certificates ──────────────────────────────────────────────

  getCertificate(positionMint: string): CertificateState | undefined {
    return this.state.certificates.find(
      (c) => c.positionMint === positionMint
    );
  }

  addCertificate(cert: CertificateState): void {
    this.state.certificates.push(cert);
    this.save();
  }

  updateCertificate(
    positionMint: string,
    updater: (cert: CertificateState) => void
  ): void {
    const cert = this.getCertificate(positionMint);
    if (!cert) throw new Error(`Certificate not found: ${positionMint}`);
    updater(cert);
    this.save();
  }

  getAllActiveCertificates(): CertificateState[] {
    return this.state.certificates.filter((c) => c.state === 1);
  }

  // ─── Share Ledger ──────────────────────────────────────────────

  getShares(address: string): number {
    return this.state.shareLedger[address] || 0;
  }

  addShares(address: string, amount: number): void {
    this.state.shareLedger[address] =
      (this.state.shareLedger[address] || 0) + amount;
    this.save();
  }

  removeShares(address: string, amount: number): void {
    const current = this.state.shareLedger[address] || 0;
    if (current < amount) throw new Error("Insufficient shares");
    this.state.shareLedger[address] = current - amount;
    this.save();
  }

  // ─── Anti-Replay ───────────────────────────────────────────────

  isTxProcessed(sig: string): boolean {
    return this.state.processedTxSigs.includes(sig);
  }

  markTxProcessed(sig: string): void {
    this.state.processedTxSigs.push(sig);
    // Keep last 1000 to prevent unbounded growth
    if (this.state.processedTxSigs.length > 1000) {
      this.state.processedTxSigs = this.state.processedTxSigs.slice(-500);
    }
    this.save();
  }
}
