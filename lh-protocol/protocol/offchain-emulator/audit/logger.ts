/**
 * Structured audit logger. Writes JSON-lines to data/audit.jsonl.
 * Every protocol operation is logged with parameters, results, and tx signatures.
 */

import * as fs from "fs";
import * as path from "path";

export interface AuditEntry {
  timestamp: string;
  operation: string;
  params: Record<string, any>;
  result: "success" | "error";
  txSignature?: string;
  stateVersion: number;
  error?: string;
}

export class AuditLogger {
  private filePath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "audit.jsonl");
  }

  log(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.filePath, line, "utf-8");
  }

  logOperation(
    operation: string,
    params: Record<string, any>,
    stateVersion: number,
    result: "success" | "error" = "success",
    txSignature?: string,
    error?: string
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      operation,
      params,
      result,
      txSignature,
      stateVersion,
      error,
    });
  }
}
