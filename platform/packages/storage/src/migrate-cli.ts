#!/usr/bin/env ts-node
/**
 * Apply the schema. Run as the MIGRATOR role (schema owner), never as the
 * app's writer role:  DATABASE_URL_MIGRATOR=... pnpm --filter @lh/storage migrate
 */
import { createPool, migrate, safeDsn } from "./pool";

async function main() {
  const dsn = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (!dsn) {
    console.error("DATABASE_URL_MIGRATOR (or DATABASE_URL) required");
    process.exit(1);
  }
  const pool = createPool({ connectionString: dsn, maxConnections: 2 });
  try {
    await migrate(pool);
    console.log(`schema applied to ${safeDsn(dsn)}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error("migration failed:", e.message ?? e);
  process.exit(1);
});
