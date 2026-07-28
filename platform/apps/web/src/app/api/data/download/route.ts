/**
 * GET /api/data/download?orderId=…&token=… — the purchased dataset.
 *
 * The token is single-use-scoped, time-limited and stored hashed; access
 * is checked against the ledger on every request, never against a cookie
 * or client state. The payload is the consolidated pool-snapshot CSV.
 */
import { type NextRequest, NextResponse } from "next/server";
import { checkLimit, tooManyRequests } from "@/lib/server/rate-limit";
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import {
  PoolSnapshot,
  snapshotTvlQuote,
  isUsdQuote,
  USD_QUOTE_MINTS,
} from "@lh/market-data";
import { CommerceUnavailableError, commerceConfig, withOrders } from "@/lib/server/order-ledger";
import { createPool, databaseUrl } from "@lh/storage";

export const dynamic = "force-dynamic";

interface TrackedPoolMeta {
  address: string;
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
  quoteMint: string;
}

function snapshotDir(): string {
  return process.env.SNAPSHOT_DIR ?? path.resolve(process.cwd(), "../../.data/pool-snapshots");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const raw = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

/** Build the consolidated long-format CSV (same shape as the email export). */
function buildDatasetCsv(dir: string): { csv: string; rows: number } {
  if (!existsSync(dir)) return { csv: "", rows: 0 };
  const metaFile = path.join(dir, "tracked-pools.json");
  const meta = new Map<string, TrackedPoolMeta>();
  if (existsSync(metaFile)) {
    try {
      const parsed = JSON.parse(readFileSync(metaFile, "utf8")) as { pools?: TrackedPoolMeta[] };
      for (const p of parsed.pools ?? []) meta.set(p.address, p);
    } catch {
      /* metadata is optional */
    }
  }

  const cols = [
    "pool", "pair", "t", "iso", "price", "liquidity",
    "feeGrowthGlobalA", "feeGrowthGlobalB", "vaultA", "vaultB",
    "decimalsA", "decimalsB", "tvlQuote", "quoteIsUsd",
  ];
  const lines: string[] = [cols.join(",")];
  let rows = 0;

  for (const f of readdirSync(dir).filter((x) => x.endsWith(".snapshots.jsonl"))) {
    const address = f.replace(".snapshots.jsonl", "");
    const m = meta.get(address);
    const decA = m?.decimalsA ?? 9;
    const decB = m?.decimalsB ?? 6;
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let s: PoolSnapshot;
      try {
        s = JSON.parse(line) as PoolSnapshot;
      } catch {
        continue;
      }
      lines.push([
        address,
        m ? `${m.symbolA}/${m.symbolB}` : "",
        s.t,
        new Date(s.t * 1000).toISOString(),
        s.price,
        s.liquidity,
        s.feeGrowthGlobalA,
        s.feeGrowthGlobalB,
        s.vaultA ?? "",
        s.vaultB ?? "",
        decA,
        decB,
        snapshotTvlQuote(s, decA, decB) ?? "",
        m ? isUsdQuote(m.quoteMint) : "",
      ].map(csvCell).join(","));
      rows++;
    }
  }
  return { csv: lines.join("\n"), rows };
}

/**
 * P2: stream the dataset straight out of Postgres with COPY. Constant
 * memory and no event-loop block — the previous in-memory build would
 * OOM the container at ~1M rows and hit V8's string limit at ~2.6M.
 */
async function streamFromPostgres(dsn: string): Promise<Response | null> {
  const pool = createPool({ connectionString: dsn, maxConnections: 2 });
  try {
    const { rows } = await pool.query(`SELECT count(*)::bigint AS n FROM lh.pool_snapshots`);
    if (Number(rows[0]?.n ?? 0) === 0) return null;

    // pg-copy-streams ships no types; the surface we use is one function.
    // COPY ... TO STDOUT accepts no bind parameters, so the mint list is
    // inlined. Every entry is checked against a strict base58 pattern
    // first: these are compile-time constants, and this keeps it that way
    // even if the set is ever sourced differently.
    const usdMintList = [...USD_QUOTE_MINTS]
      .map((m) => {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) {
          throw new Error(`refusing to inline non-base58 mint: ${m}`);
        }
        return `'${m}'`;
      })
      .join(", ");

    const { to: copyTo } = await import("pg-copy-streams");
    const client = await pool.connect();
    // AUDIT #6: this emitted 12 snake_case columns while /data publishes a
    // 14-field camelCase specification that buyers are told to read before
    // paying. `tvlQuote` and `quoteIsUsd` were absent entirely. Column
    // names and order now mirror CSV_FIELDS exactly; the header is asserted
    // against it in tests/unit/csv-schema.test.ts so the two cannot drift.
    const sql = `COPY (
        SELECT s.pool                                              AS "pool",
               coalesce(p.symbol_a || '/' || p.symbol_b, '')       AS "pair",
               s.t                                                 AS "t",
               to_char(to_timestamp(s.t) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "iso",
               s.price                                             AS "price",
               s.liquidity                                         AS "liquidity",
               s.fee_growth_global_a                               AS "feeGrowthGlobalA",
               s.fee_growth_global_b                               AS "feeGrowthGlobalB",
               s.vault_a                                           AS "vaultA",
               s.vault_b                                           AS "vaultB",
               p.decimals_a                                        AS "decimalsA",
               p.decimals_b                                        AS "decimalsB",
               CASE WHEN p.decimals_a IS NULL OR p.decimals_b IS NULL THEN NULL
                    ELSE s.vault_b / power(10::numeric, p.decimals_b)
                       + (s.vault_a / power(10::numeric, p.decimals_a)) * s.price
               END                                                 AS "tvlQuote",
               CASE WHEN p.quote_mint IS NULL THEN ''
                    WHEN p.quote_mint = ANY (ARRAY[${usdMintList}]) THEN 'true'
                    ELSE 'false'
               END                                                 AS "quoteIsUsd"
          FROM lh.pool_snapshots s
          LEFT JOIN lh.tracked_pools p ON p.address = s.pool
         ORDER BY s.pool, s.t
      ) TO STDOUT WITH (FORMAT csv, HEADER true)`;
    const source = client.query(
      copyTo(sql) as unknown as Parameters<typeof client.query>[0],
    ) as unknown as NodeJS.ReadableStream;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        source.on("end", () => {
          controller.close();
          client.release();
          void pool.end();
        });
        source.on("error", (err: Error) => {
          controller.error(err);
          client.release();
          void pool.end();
        });
      },
    });
    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="lh-orca-fee-growth-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[api/data/download] postgres stream failed:", e);
    await pool.end().catch(() => undefined);
    return null;
  }
}

export async function GET(req: NextRequest) {
  // A10: cost-tiered rate limit, keyed on the trusted last hop.
  const limit = checkLimit(req, "download");
  if (!limit.ok) return tooManyRequests(limit);
  try {
    commerceConfig();
  } catch (e) {
    if (e instanceof CommerceUnavailableError) {
      return NextResponse.json({ error: "Data sales are not configured." }, { status: 503 });
    }
    throw e;
  }

  const orderId = req.nextUrl.searchParams.get("orderId") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{4,64}$/i.test(orderId) || token.length < 16 || token.length > 128) {
    return NextResponse.json({ error: "Invalid download link." }, { status: 400 });
  }

  // B7: prove the stream is PRODUCIBLE before touching order state or
  // the single-use token — a paid buyer must never burn their grant on
  // a 503. The probe hits the same sources the stream will use; the
  // residual race (store dying between probe and stream) is recoverable
  // via the claim secret, which re-issues a fresh grant.
  const dsnProbe = databaseUrl();
  let producible = false;
  if (dsnProbe) {
    const probePool = createPool({ connectionString: dsnProbe, maxConnections: 1, connectTimeoutMs: 3_000 });
    try {
      const { rows } = await probePool.query(
        `SELECT count(*)::bigint AS n FROM lh.pool_snapshots`,
      );
      producible = Number(rows[0]?.n ?? 0) > 0;
    } catch {
      producible = false;
    } finally {
      await probePool.end().catch(() => undefined);
    }
  }
  if (!producible) {
    const dir = snapshotDir();
    producible =
      existsSync(dir) &&
      readdirSync(dir).some((f) => f.endsWith(".snapshots.jsonl"));
  }
  if (!producible) {
    return NextResponse.json(
      {
        error:
          "Dataset is temporarily unavailable. Your download link has NOT been used — retry shortly.",
      },
      { status: 503 },
    );
  }

  // Consume the grant, atomically. The link is advertised as single-use;
  // a pure check left it live for the full 24h TTL. Consumed BEFORE the
  // stream so concurrent requests cannot both pass — a failed download is
  // recoverable via the claim secret, which re-issues a fresh grant.
  const ok = await withOrders((l) => l.redeemDownloadToken(orderId, token));
  if (!ok) {
    // One message for wrong/expired/unknown — no oracle for probing.
    return NextResponse.json({ error: "This download link is invalid or has expired." }, { status: 403 });
  }

  // P0: production data lives in Postgres; the JSONL path remains for dev.
  const dsn = databaseUrl();
  if (dsn) {
    const streamed = await streamFromPostgres(dsn);
    if (streamed) return streamed;
  }

  const { csv, rows } = buildDatasetCsv(snapshotDir());
  if (rows === 0) {
    return NextResponse.json({ error: "Dataset is not available yet." }, { status: 503 });
  }
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="lh-orca-fee-growth-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
      "X-Row-Count": String(rows),
    },
  });
}
