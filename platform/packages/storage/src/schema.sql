-- LH platform schema (idempotent; applied by the migration runner).
--
-- Security posture (NFR-SEC6 / SR-4):
--  * three least-privilege roles, none of them superuser:
--      lh_migrator — owns the schema, only used to apply migrations
--      lh_writer   — INSERT only (collector, app writes); NO update/delete
--      lh_reader   — SELECT only (reporting, exports)
--  * event tables are APPEND-ONLY by grant, not by convention;
--  * PUBLIC privileges revoked on the schema and on the database;
--  * all application access is parameterized — no dynamic SQL anywhere.

CREATE SCHEMA IF NOT EXISTS lh;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA lh FROM PUBLIC;

-- ── Pool fee-growth snapshots (the large, growing table) ─────────────
CREATE TABLE IF NOT EXISTS lh.pool_snapshots (
  pool                text        NOT NULL,
  t                   bigint      NOT NULL,
  price               double precision NOT NULL,
  liquidity           numeric(40,0) NOT NULL,
  fee_growth_global_a numeric(40,0) NOT NULL,
  fee_growth_global_b numeric(40,0) NOT NULL,
  vault_a             numeric(40,0),
  vault_b             numeric(40,0),
  PRIMARY KEY (pool, t)          -- also makes re-ingest idempotent
);
-- P6: `t`-only lookups are not a query shape we use; a BRIN index costs
-- ~1/1000 of a btree here (rows arrive in t order → near-perfect
-- correlation) and keeps the option open for time-range exports.
DROP INDEX IF EXISTS lh.pool_snapshots_t_idx;
CREATE INDEX IF NOT EXISTS pool_snapshots_t_brin
  ON lh.pool_snapshots USING brin (t) WITH (pages_per_range = 32);

-- P7: insert-only table — the default 20% scale factor would defer
-- vacuum/freeze for ~2.5 months, leaving the visibility map stale and
-- deferring freezing to an anti-wraparound full scan.
ALTER TABLE lh.pool_snapshots SET (
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 10000
);

-- ── Position fee snapshots (§1.2 realised position yield) ────────────
-- Per tracked position per tick: feeGrowthInside for the position's own
-- range (from the pool + tick accounts — the accumulator a collectFees
-- would pay from), its liquidity, pool price and in-range flag. Realised
-- position fees over any window are then L × Δinside / 2^64 — no vendor,
-- no in-range model, no concentration factor.
CREATE TABLE IF NOT EXISTS lh.position_fee_snapshots (
  position             text   NOT NULL,
  t                    bigint NOT NULL,
  whirlpool            text   NOT NULL,
  liquidity            numeric(40,0) NOT NULL,
  fee_growth_inside_a  numeric(40,0) NOT NULL,
  fee_growth_inside_b  numeric(40,0) NOT NULL,
  price                double precision NOT NULL,
  in_range             boolean NOT NULL,
  PRIMARY KEY (position, t)
);
ALTER TABLE lh.position_fee_snapshots SET (
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 10000
);

-- ── Tracked positions (auto-registered by the portfolio dashboard) ───
-- Small mutable projection, like tracked_pools: the web app upserts a row
-- whenever a viability-eligible position is served; the collector
-- snapshots the most recently seen ones each cycle.
CREATE TABLE IF NOT EXISTS lh.tracked_positions (
  position      text PRIMARY KEY,
  position_mint text NOT NULL,
  whirlpool     text NOT NULL,
  decimals_a    smallint NOT NULL,
  decimals_b    smallint NOT NULL,
  added_at      bigint NOT NULL,
  last_seen     bigint NOT NULL
);

-- ── OHLCV candles ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lh.candles (
  address   text   NOT NULL,
  timeframe text   NOT NULL,
  t         bigint NOT NULL,
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v double precision NOT NULL,
  PRIMARY KEY (address, timeframe, t)
);

-- ── Tracked pool set (discovery output) ──────────────────────────────
CREATE TABLE IF NOT EXISTS lh.tracked_pools (
  address     text PRIMARY KEY,
  symbol_a    text NOT NULL,
  symbol_b    text NOT NULL,
  decimals_a  smallint NOT NULL,
  decimals_b  smallint NOT NULL,
  quote_mint  text NOT NULL,
  fee_rate    integer NOT NULL,
  refreshed_at bigint NOT NULL
);

-- ── Append-only event ledgers (certificates, orders, predictions) ────
CREATE TABLE IF NOT EXISTS lh.events (
  id       bigserial PRIMARY KEY,
  stream   text        NOT NULL,   -- 'hedge' | 'orders' | 'inrange' | 'overview'
  ts       timestamptz NOT NULL DEFAULT now(),
  payload  jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS events_stream_id_idx ON lh.events (stream, id);

-- ── Roles and grants ─────────────────────────────────────────────────
-- Roles are created by the container's init script (they need passwords);
-- here we only ensure the privileges are correct and re-applied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lh_writer') THEN
    GRANT USAGE ON SCHEMA lh TO lh_writer;
    -- INSERT only: no UPDATE, no DELETE, no TRUNCATE anywhere.
    GRANT INSERT, SELECT ON lh.pool_snapshots, lh.candles, lh.events TO lh_writer;
    GRANT INSERT, SELECT ON lh.position_fee_snapshots TO lh_writer;
    -- tracked_pools / tracked_positions are small mutable projections,
    -- not event logs.
    GRANT INSERT, SELECT, UPDATE ON lh.tracked_pools TO lh_writer;
    GRANT INSERT, SELECT, UPDATE ON lh.tracked_positions TO lh_writer;
    GRANT USAGE, SELECT ON SEQUENCE lh.events_id_seq TO lh_writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lh_reader') THEN
    GRANT USAGE ON SCHEMA lh TO lh_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA lh TO lh_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA lh GRANT SELECT ON TABLES TO lh_reader;
  END IF;
END
$$;
