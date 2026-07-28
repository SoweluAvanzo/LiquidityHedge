/**
 * B1 (§Phase 2): the covered period and EXACT row count, quoted before
 * payment. One aggregate query on the live table — the same table the
 * download streams from, so the quote and the delivery cannot diverge.
 * Null when Postgres is unavailable (the order proceeds; the response
 * says coverage could not be quoted rather than inventing numbers).
 */

import { getDbPool } from "./db";

export interface DatasetCoverage {
  rows: number;
  pools: number;
  firstT: number | null;
  lastT: number | null;
}

export async function datasetCoverage(): Promise<DatasetCoverage | null> {
  const db = getDbPool();
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT count(*)::bigint AS n, count(DISTINCT pool)::bigint AS pools,
              min(t) AS min_t, max(t) AS max_t
         FROM lh.pool_snapshots`,
    );
    const r = rows[0] ?? {};
    return {
      rows: Number(r.n ?? 0),
      pools: Number(r.pools ?? 0),
      firstT: r.min_t === null || r.min_t === undefined ? null : Number(r.min_t),
      lastT: r.max_t === null || r.max_t === undefined ? null : Number(r.max_t),
    };
  } catch (error) {
    console.error(
      "[dataset-coverage] unavailable:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
