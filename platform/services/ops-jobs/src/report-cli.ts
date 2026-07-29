#!/usr/bin/env ts-node
/**
 * Data export: summarize the accumulating ledgers, attach them as CSV, and
 * email via Resend.
 *
 *   pnpm --filter @lh/ops-jobs data-report            # dry run (writes to disk)
 *   RESEND_API_KEY=… pnpm --filter @lh/ops-jobs data-report --send
 *   REPORT_INTERVAL_HOURS=48 … data-report --send --loop   # resident sender
 *
 * Env:
 *   RESEND_API_KEY         required to send
 *   REPORT_FROM            sender (verified Resend domain), default reports@…
 *   REPORT_TO              comma-separated recipients (default: the two owners)
 *   SNAPSHOT_DIR           pool snapshots dir
 *   WEB_DATA_DIR           web app .data dir
 *   REPORT_OUT_DIR         where dry-run artifacts are written
 *   REPORT_INTERVAL_HOURS  loop cadence (default 48 = every 2 days)
 */

import * as fs from "fs";
import * as path from "path";
import { buildDataReport, type PoolDataSource } from "./data-report";
import { sendReportViaResend } from "./email-transport";
import {
  numericEnv,
  createPool,
  safeDsn,
  PgPoolSnapshotStore,
  PgTrackedPoolStore,
} from "@lh/storage";

/** Read a var from the environment, falling back to lh-protocol/.env —
 *  the same convention the other CLIs use for local runs. */
function envVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envPath = path.resolve(__dirname, "../../../../lh-protocol/.env");
  if (!fs.existsSync(envPath)) return undefined;
  const m = fs.readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
  return m?.[1]?.trim();
}

const DEFAULT_TO = ["sowelu.avanzo@nortadesyco.xyz", "sowelu94@gmail.com", "marco.ottina@nortadesyco.xyz", "ottins1995@gmail.com"];

function inputs() {
  return {
    snapshotDir:
      process.env.SNAPSHOT_DIR ?? path.resolve(__dirname, "../../../.data/pool-snapshots"),
    webDataDir:
      process.env.WEB_DATA_DIR ?? path.resolve(__dirname, "../../../apps/web/.data"),
  };
}

/**
 * #3: production truth lives in Postgres — the JSONL dir inside the
 * image is a frozen dev copy (it shipped 642 rows while the store held
 * 6,955). Returns null (dir fallback) when DATABASE_URL is unset or the
 * store is unreachable; the report then LABELS its source either way.
 */
async function loadPoolDataFromPostgres(): Promise<PoolDataSource[] | null> {
  const dsn = envVar("DATABASE_URL");
  if (!dsn) return null;
  const pg = createPool({ connectionString: dsn, maxConnections: 2 });
  try {
    const snaps = new PgPoolSnapshotStore(pg);
    const tracked = new PgTrackedPoolStore(pg);
    const metaByAddress = new Map(
      (await tracked.list()).map((t) => [t.address, t]),
    );
    const now = Math.floor(Date.now() / 1000);
    const out: PoolDataSource[] = [];
    for (const address of await snaps.pools()) {
      out.push({
        address,
        meta: metaByAddress.get(address) ?? null,
        rows: await snaps.read(address, 0, now),
      });
    }
    console.log(`dataset source: postgres ${safeDsn(dsn)} (${out.length} pools)`);
    return out;
  } catch (e) {
    console.error(
      "postgres dataset source unavailable, falling back to files:",
      e instanceof Error ? e.message : e,
    );
    return null;
  } finally {
    await pg.end().catch(() => undefined);
  }
}

async function runOnce(send: boolean): Promise<void> {
  const poolData = await loadPoolDataFromPostgres();
  const report = buildDataReport(
    { ...inputs(), ...(poolData ? { poolData } : {}) },
    new Date().toISOString(),
  );
  console.log(report.text);

  if (report.datasets.length === 0) {
    console.log("nothing to report yet — no ledgers found");
    return;
  }

  if (!send) {
    const out = process.env.REPORT_OUT_DIR ?? path.resolve(__dirname, "../../../.data/reports");
    fs.mkdirSync(out, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    for (const a of report.attachments) {
      fs.writeFileSync(
        path.join(out, `${stamp}_${a.filename}`),
        Buffer.from(a.content, "base64"),
      );
    }
    fs.writeFileSync(path.join(out, `${stamp}_report.html`), report.html);
    console.log(
      `DRY RUN — wrote ${report.attachments.length} CSV file(s) + report.html to ${out}\n` +
        `Add --send (with RESEND_API_KEY) to email it.`,
    );
    return;
  }

  const result = await sendReportViaResend(report, {
    apiKey: envVar("RESEND_API_KEY") ?? "",
    from: envVar("REPORT_FROM") ?? "LH Reports <reports@nortadesyco.xyz>",
    to: (envVar("REPORT_TO") ?? DEFAULT_TO.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
  });
  console.log(
    `SENT id=${result.id} to=${result.to.join(", ")} attachments=${result.attachments}`,
  );
}

async function main() {
  const send = process.argv.includes("--send");
  const loop = process.argv.includes("--loop");
  await runOnce(send).catch((e) => {
    console.error("report failed:", e.message ?? e);
    if (!loop) process.exit(1);
  });

  if (loop) {
    const hours = numericEnv("REPORT_INTERVAL_HOURS", 48);
    console.log(`resident mode: sending every ${hours} h`);
    setInterval(
      () => {
        runOnce(send).catch((e) => console.error("report cycle failed:", e.message ?? e));
      },
      hours * 3600 * 1000,
    );
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
