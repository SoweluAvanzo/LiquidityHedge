/**
 * Postgres implementations of the existing store ports. Drop-in
 * replacements for the file-backed dev stores — same interfaces, so
 * nothing above them changes.
 *
 * Every statement is parameterized. Bulk inserts use UNNEST with typed
 * arrays (one round-trip, still fully parameterized).
 */

import { Pool } from "pg";
import {
  Candle,
  CandleStore,
  PoolSnapshot,
  PoolSnapshotStore,
  Timeframe,
} from "@lh/market-data";

export class PgPoolSnapshotStore implements PoolSnapshotStore {
  constructor(private readonly pool: Pool) {}

  async append(poolAddress: string, snapshot: PoolSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO lh.pool_snapshots
         (pool, t, price, liquidity, fee_growth_global_a, fee_growth_global_b, vault_a, vault_b)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (pool, t) DO NOTHING`,
      [
        poolAddress,
        snapshot.t,
        snapshot.price,
        snapshot.liquidity,
        snapshot.feeGrowthGlobalA,
        snapshot.feeGrowthGlobalB,
        snapshot.vaultA ?? null,
        snapshot.vaultB ?? null,
      ],
    );
  }

  /** Batch insert for a collector cycle — one round-trip for all pools. */
  async appendMany(rows: { pool: string; snapshot: PoolSnapshot }[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await this.pool.query(
      `INSERT INTO lh.pool_snapshots
         (pool, t, price, liquidity, fee_growth_global_a, fee_growth_global_b, vault_a, vault_b)
       SELECT * FROM UNNEST(
         $1::text[], $2::bigint[], $3::double precision[], $4::numeric[],
         $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
       ON CONFLICT (pool, t) DO NOTHING`,
      [
        rows.map((r) => r.pool),
        rows.map((r) => r.snapshot.t),
        rows.map((r) => r.snapshot.price),
        rows.map((r) => r.snapshot.liquidity),
        rows.map((r) => r.snapshot.feeGrowthGlobalA),
        rows.map((r) => r.snapshot.feeGrowthGlobalB),
        rows.map((r) => r.snapshot.vaultA ?? null),
        rows.map((r) => r.snapshot.vaultB ?? null),
      ],
    );
    return res.rowCount ?? 0;
  }

  async read(poolAddress: string, timeFrom: number, timeTo: number): Promise<PoolSnapshot[]> {
    const { rows } = await this.pool.query(
      `SELECT t, price, liquidity, fee_growth_global_a, fee_growth_global_b, vault_a, vault_b
         FROM lh.pool_snapshots
        WHERE pool = $1 AND t BETWEEN $2 AND $3
        ORDER BY t`,
      [poolAddress, timeFrom, timeTo],
    );
    return rows.map(toSnapshot);
  }

  async latest(poolAddress: string): Promise<PoolSnapshot | null> {
    const { rows } = await this.pool.query(
      `SELECT t, price, liquidity, fee_growth_global_a, fee_growth_global_b, vault_a, vault_b
         FROM lh.pool_snapshots WHERE pool = $1 ORDER BY t DESC LIMIT 1`,
      [poolAddress],
    );
    return rows.length > 0 ? toSnapshot(rows[0]) : null;
  }

  /** Distinct pools with data — used by the export job. */
  async pools(): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT pool FROM lh.pool_snapshots ORDER BY pool`,
    );
    return rows.map((r: { pool: string }) => r.pool);
  }
}

function toSnapshot(r: Record<string, unknown>): PoolSnapshot {
  return {
    t: Number(r.t),
    price: Number(r.price),
    liquidity: String(r.liquidity),
    feeGrowthGlobalA: String(r.fee_growth_global_a),
    feeGrowthGlobalB: String(r.fee_growth_global_b),
    vaultA: r.vault_a === null ? undefined : String(r.vault_a),
    vaultB: r.vault_b === null ? undefined : String(r.vault_b),
  };
}

export class PgCandleStore implements CandleStore {
  constructor(private readonly pool: Pool) {}

  async upsert(address: string, timeframe: Timeframe, candles: Candle[]): Promise<number> {
    if (candles.length === 0) return 0;
    const res = await this.pool.query(
      `INSERT INTO lh.candles (address, timeframe, t, o, h, l, c, v)
       SELECT $1, $2, * FROM UNNEST(
         $3::bigint[], $4::double precision[], $5::double precision[],
         $6::double precision[], $7::double precision[], $8::double precision[])
       ON CONFLICT (address, timeframe, t) DO NOTHING`,
      [
        address,
        timeframe,
        candles.map((c) => c.t),
        candles.map((c) => c.o),
        candles.map((c) => c.h),
        candles.map((c) => c.l),
        candles.map((c) => c.c),
        candles.map((c) => c.v),
      ],
    );
    return res.rowCount ?? 0;
  }

  async read(
    address: string,
    timeframe: Timeframe,
    timeFrom: number,
    timeTo: number,
  ): Promise<Candle[]> {
    const { rows } = await this.pool.query(
      `SELECT t, o, h, l, c, v FROM lh.candles
        WHERE address = $1 AND timeframe = $2 AND t BETWEEN $3 AND $4
        ORDER BY t`,
      [address, timeframe, timeFrom, timeTo],
    );
    return rows.map((r: Record<string, unknown>) => ({
      t: Number(r.t),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: Number(r.v),
    }));
  }

  async latest(address: string, timeframe: Timeframe): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT max(t) AS t FROM lh.candles WHERE address = $1 AND timeframe = $2`,
      [address, timeframe],
    );
    return rows[0]?.t === null || rows[0]?.t === undefined ? null : Number(rows[0].t);
  }
}

/**
 * Append-only event store. The writer role has no UPDATE/DELETE grant, so
 * immutability is enforced by the database, not by this code.
 */
export class PgEventStore {
  constructor(private readonly pool: Pool) {}

  async append(stream: string, payload: unknown): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO lh.events (stream, payload) VALUES ($1, $2::jsonb) RETURNING id`,
      [stream, JSON.stringify(payload)],
    );
    return Number(rows[0].id);
  }

  async read(stream: string, opts?: { afterId?: number; limit?: number }): Promise<
    { id: number; ts: string; payload: unknown }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT id, ts, payload FROM lh.events
        WHERE stream = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [stream, opts?.afterId ?? 0, Math.min(opts?.limit ?? 10_000, 50_000)],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      ts: String(r.ts),
      payload: r.payload,
    }));
  }
}
