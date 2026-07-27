/**
 * Server-side Postgres access for the web app (lh_writer role).
 *
 * The pool is a process singleton (survives dev HMR via globalThis, same
 * pattern as the hedge ledger). `null` when DATABASE_URL is not
 * configured — every consumer treats that as "measured data unavailable"
 * and falls back to its labelled modelled path; nothing throws at import
 * time, so a DB-less dev environment still serves the dashboard.
 */

import type { Pool } from "pg";
import { createPool, databaseUrl } from "@lh/storage";

const registry = globalThis as unknown as {
  __lhDbPool?: Pool | null;
};

export function getDbPool(): Pool | null {
  if (registry.__lhDbPool !== undefined) return registry.__lhDbPool;
  const dsn = databaseUrl();
  if (!dsn) {
    registry.__lhDbPool = null;
    return null;
  }
  registry.__lhDbPool = createPool({
    connectionString: dsn,
    // The web app is a light reader/register — the collector owns the
    // write volume. Keep the footprint small (max_connections=20 server-wide).
    maxConnections: 4,
    statementTimeoutMs: 10_000,
    // Short connect timeout: several reads run per portfolio request,
    // and each would serialise a full connect wait with Postgres down.
    connectTimeoutMs: 3_000,
  });
  return registry.__lhDbPool;
}
