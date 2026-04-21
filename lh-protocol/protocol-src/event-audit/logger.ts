/**
 * Liquidity Hedge Protocol — Structured Audit Logger
 *
 * Writes append-only JSONL entries for every protocol operation.
 * Used for debugging, compliance, and post-hoc analysis.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: string;
  operation: string;
  params: Record<string, unknown>;
  result: "success" | "error";
  details?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export class AuditLogger {
  private filePath: string | null;
  private entries: AuditEntry[] = [];

  constructor(dataDir?: string) {
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.filePath = path.join(dataDir, "audit.jsonl");
    } else {
      this.filePath = null;
    }
  }

  /**
   * Log a successful operation.
   */
  logSuccess(
    operation: string,
    params: Record<string, unknown>,
    details?: Record<string, unknown>,
  ): void {
    this.write({
      timestamp: new Date().toISOString(),
      operation,
      params,
      result: "success",
      details,
    });
  }

  /**
   * Log a failed operation.
   */
  logError(
    operation: string,
    params: Record<string, unknown>,
    error: string,
  ): void {
    this.write({
      timestamp: new Date().toISOString(),
      operation,
      params,
      result: "error",
      error,
    });
  }

  /**
   * Get all logged entries (for testing).
   */
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  private write(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.filePath) {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    }
  }
}
