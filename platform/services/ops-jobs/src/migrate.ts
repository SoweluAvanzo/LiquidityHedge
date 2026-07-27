#!/usr/bin/env ts-node
/**
 * Schema migration entrypoint for the `migrate` container.
 *
 * Runs as the ADMIN role (schema owner) and exits. The web and collector
 * services wait for it to complete successfully before starting, so a
 * fresh cloud deployment converges without any manual psql step.
 */
import { createPool, migrate, safeDsn } from "@lh/storage";
import { secretEnv } from "@lh/storage";

async function main() {
  const dsn = secretEnv("DATABASE_URL_MIGRATOR");
  if (!dsn) {
    console.error("DATABASE_URL_MIGRATOR required (admin role)");
    process.exit(1);
  }
  const pool = createPool({ connectionString: dsn, maxConnections: 2 });
  try {
    await migrate(pool);
    console.log(`schema applied: ${safeDsn(dsn)}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error("migration failed:", e.message ?? e);
  process.exit(1);
});
