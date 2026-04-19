/**
 * Liquidity Hedge Protocol — In-Memory State Store
 *
 * Manages all protocol state: pool, positions, certificates, regime,
 * templates, and the share ledger. Supports JSON serialization for
 * persistence and debugging.
 *
 * Design follows the v1 StateStore pattern with v3's cleaner interfaces.
 */

import * as fs from "fs";
import * as path from "path";
import {
  PoolState,
  PositionState,
  CertificateState,
  RegimeSnapshot,
  TemplateConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Serializable protocol state
// ---------------------------------------------------------------------------

export interface ProtocolState {
  version: number;
  pool: PoolState | null;
  regime: RegimeSnapshot | null;
  templates: TemplateConfig[];
  positions: PositionState[];
  certificates: CertificateState[];
  shareLedger: Record<string, number>;
}

const INITIAL_STATE: ProtocolState = {
  version: 1,
  pool: null,
  regime: null,
  templates: [],
  positions: [],
  certificates: [],
  shareLedger: {},
};

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  private state: ProtocolState;
  private dataDir: string | null;

  constructor(dataDir?: string) {
    this.state = {
      version: 1,
      pool: null,
      regime: null,
      templates: [],
      positions: [],
      certificates: [],
      shareLedger: {},
    };
    this.dataDir = dataDir ?? null;

    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const filePath = path.join(this.dataDir, "protocol-state.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        this.state = JSON.parse(raw);
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────

  private persist(): void {
    if (!this.dataDir) return;
    const filePath = path.join(this.dataDir, "protocol-state.json");
    fs.writeFileSync(filePath, JSON.stringify(this.state, null, 2));
  }

  /** Export full state snapshot (for testing / inspection) */
  getFullState(): ProtocolState {
    return { ...this.state };
  }

  /** Replace full state (for testing) */
  loadState(state: ProtocolState): void {
    this.state = state;
  }

  // ── Pool ────────────────────────────────────────────────────

  getPool(): PoolState | null {
    return this.state.pool;
  }

  setPool(pool: PoolState): void {
    this.state.pool = pool;
    this.persist();
  }

  updatePool(fn: (pool: PoolState) => void): void {
    if (!this.state.pool) throw new Error("Pool not initialized");
    fn(this.state.pool);
    this.persist();
  }

  // ── Positions ───────────────────────────────────────────────

  getPosition(mintStr: string): PositionState | null {
    return this.state.positions.find((p) => p.positionMint === mintStr) ?? null;
  }

  addPosition(pos: PositionState): void {
    if (this.getPosition(pos.positionMint)) {
      throw new Error(`Position ${pos.positionMint} already exists`);
    }
    this.state.positions.push(pos);
    this.persist();
  }

  updatePosition(mintStr: string, fn: (pos: PositionState) => void): void {
    const pos = this.getPosition(mintStr);
    if (!pos) throw new Error(`Position ${mintStr} not found`);
    fn(pos);
    this.persist();
  }

  getAllPositions(): PositionState[] {
    return [...this.state.positions];
  }

  // ── Certificates ────────────────────────────────────────────

  getCertificate(positionMint: string): CertificateState | null {
    return (
      this.state.certificates.find((c) => c.positionMint === positionMint) ??
      null
    );
  }

  addCertificate(cert: CertificateState): void {
    this.state.certificates.push(cert);
    this.persist();
  }

  updateCertificate(
    positionMint: string,
    fn: (cert: CertificateState) => void,
  ): void {
    const cert = this.getCertificate(positionMint);
    if (!cert)
      throw new Error(`Certificate for position ${positionMint} not found`);
    fn(cert);
    this.persist();
  }

  getActiveCertificates(): CertificateState[] {
    return this.state.certificates.filter((c) => c.state === 1); // Active
  }

  // ── Templates ───────────────────────────────────────────────

  getTemplate(id: number): TemplateConfig | null {
    return this.state.templates.find((t) => t.templateId === id) ?? null;
  }

  addTemplate(t: TemplateConfig): void {
    if (this.getTemplate(t.templateId)) {
      throw new Error(`Template ${t.templateId} already exists`);
    }
    this.state.templates.push(t);
    this.persist();
  }

  getAllTemplates(): TemplateConfig[] {
    return [...this.state.templates];
  }

  // ── Regime ──────────────────────────────────────────────────

  getRegime(): RegimeSnapshot | null {
    return this.state.regime;
  }

  setRegime(regime: RegimeSnapshot): void {
    this.state.regime = regime;
    this.persist();
  }

  // ── Share Ledger ────────────────────────────────────────────

  getShares(owner: string): number {
    return this.state.shareLedger[owner] ?? 0;
  }

  addShares(owner: string, amount: number): void {
    this.state.shareLedger[owner] =
      (this.state.shareLedger[owner] ?? 0) + amount;
    this.persist();
  }

  removeShares(owner: string, amount: number): void {
    const current = this.state.shareLedger[owner] ?? 0;
    if (current < amount) {
      throw new Error(
        `Insufficient shares: ${owner} has ${current}, requested ${amount}`,
      );
    }
    this.state.shareLedger[owner] = current - amount;
    if (this.state.shareLedger[owner] === 0) {
      delete this.state.shareLedger[owner];
    }
    this.persist();
  }

  getAllShareholders(): Record<string, number> {
    return { ...this.state.shareLedger };
  }
}
