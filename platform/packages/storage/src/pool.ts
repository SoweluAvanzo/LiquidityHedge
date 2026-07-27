/**
 * PostgreSQL connection factory with safe defaults.
 *
 * Hardening notes:
 *  - the database is never published on the host (internal network only);
 *  - the app connects as `lh_writer`/`lh_reader`, never as superuser;
 *  - statement_timeout bounds any pathological query;
 *  - TLS is used when PGSSLMODE=require (managed/remote deployments);
 *  - every query in this package is parameterized — there is no dynamic
 *    SQL construction anywhere, which is what keeps injection off the table.
 */

import { Pool, PoolConfig } from "pg";
import * as fs from "fs";
import * as path from "path";

export interface StorageConfig {
  /** postgres://user:pass@host:5432/db — never logged. */
  connectionString: string;
  /** Max pool size; keep small so one service cannot exhaust the server. */
  maxConnections?: number;
  statementTimeoutMs?: number;
  /** Connect timeout. Request-path callers (the web app) should keep
   *  this SHORT: with Postgres down, every read in a request serialises
   *  a full connect wait, and "DB down" must not look like "site down". */
  connectTimeoutMs?: number;
  ssl?: boolean;
}

export function createPool(config: StorageConfig): Pool {
  const cfg: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections ?? 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: config.connectTimeoutMs ?? 10_000,
    // Bound every statement; a runaway query cannot pin the server.
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    application_name: "lh-platform",
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
  };
  return new Pool(cfg);
}

/** Apply the idempotent schema. Run as the migrator role only. */
export async function migrate(pool: Pool): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}

/** Redact credentials before anything reaches a log line. */
export function safeDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DSN)";
  }
}
