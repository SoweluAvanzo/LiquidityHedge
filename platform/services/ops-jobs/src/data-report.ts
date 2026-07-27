/**
 * Data-export report: summarizes the platform's accumulating ledgers and
 * packages the raw files for delivery (email via Resend, or disk).
 *
 * Pure builder (no I/O beyond reading the given files) so it is testable;
 * the transport lives in `email-transport.ts`.
 */

import * as fs from "fs";
import * as path from "path";
import {
  PoolSnapshot,
  computeRangeFeeYield,
  rangeYieldUsd,
  snapshotTvlQuote,
  isUsdQuote,
} from "@lh/market-data";

interface TrackedPoolMeta {
  address: string;
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
  quoteMint: string;
}

/** Per-pool decimals/symbols written by the collector's discovery step. */
function loadTrackedMeta(dir: string): Map<string, TrackedPoolMeta> {
  const file = path.join(dir, "tracked-pools.json");
  if (!fs.existsSync(file)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      pools?: TrackedPoolMeta[];
    };
    return new Map((parsed.pools ?? []).map((p) => [p.address, p]));
  } catch {
    return new Map();
  }
}

export interface DatasetSummary {
  name: string;
  file: string;
  rows: number;
  bytes: number;
  firstTs: string | null;
  lastTs: string | null;
  notes: string[];
}

export interface ReportAttachment {
  filename: string;
  /** Base64-encoded CSV (Resend's attachment encoding). */
  content: string;
  bytes: number;
}

export interface DataReport {
  generatedAt: string;
  datasets: DatasetSummary[];
  attachments: ReportAttachment[];
  subject: string;
  text: string;
  html: string;
  /** Files skipped because they exceeded the size budget. */
  skipped: string[];
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_TOTAL_BYTES = 15 * 1024 * 1024; //     15 MB total (mail limits)

function readJsonl(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
}

/** Flatten JSONL rows to CSV: union of keys as header, RFC-4180 quoting. */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  }
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const raw = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(",")),
  ].join("\n");
}

function isoOf(row: unknown): string | null {
  const r = row as { ts?: string; t?: number };
  if (typeof r?.ts === "string") return r.ts;
  if (typeof r?.t === "number") return new Date(r.t * 1000).toISOString();
  return null;
}

/** Cross-pool summary: coverage, aggregate USD TVL, and the busiest pools. */
function summarizeAllPools(
  perPool: { address: string; rows: PoolSnapshot[] }[],
  meta: Map<string, TrackedPoolMeta>,
): string[] {
  const notes: string[] = [];
  const spans = perPool.map((p) => p.rows[p.rows.length - 1].t - p.rows[0].t);
  const maxSpanH = Math.max(...spans, 0) / 3600;
  notes.push(
    `${perPool.length} pools · ${perPool.reduce((s, p) => s + p.rows.length, 0)} snapshots · ` +
      `longest series ${maxSpanH.toFixed(1)} h`,
  );

  let usdTvl = 0;
  let usdPools = 0;
  for (const p of perPool) {
    const m = meta.get(p.address);
    if (!m || !isUsdQuote(m.quoteMint)) continue;
    const last = p.rows[p.rows.length - 1];
    const tvl = snapshotTvlQuote(last, m.decimalsA, m.decimalsB);
    if (tvl !== null) {
      usdTvl += tvl;
      usdPools++;
    }
  }
  if (usdPools > 0) {
    notes.push(
      `latest on-chain TVL across ${usdPools} USD-quoted pools: ` +
        `$${usdTvl.toLocaleString("en-US", { maximumFractionDigits: 0 })} ` +
        `(other pools quote in non-USD tokens and are not summed)`,
    );
  }

  // Exact fee yield per unit of liquidity, ±5% around each pool's first
  // price — ranked, so the busiest fee generators are visible at a glance.
  const ranked = perPool
    .map((p) => {
      const m = meta.get(p.address);
      const decA = m?.decimalsA ?? 9;
      const decB = m?.decimalsB ?? 6;
      const s0 = p.rows[0].price;
      const y = computeRangeFeeYield(p.rows, s0 * 0.95, s0 * 1.05, 1_000_000_000n);
      return {
        label: m ? `${m.symbolA}/${m.symbolB}` : p.address.slice(0, 6),
        fees: rangeYieldUsd(y, s0, decA, decB),
        hours: y.totalSeconds / 3600,
      };
    })
    .filter((r) => r.hours > 0)
    .sort((a, b) => b.fees - a.fees)
    .slice(0, 5);
  if (ranked.length > 0) {
    notes.push(
      `top fee generators for L=1e9 in ±5% (quote units): ` +
        ranked.map((r) => `${r.label} ${r.fees.toExponential(2)}`).join(", "),
    );
  }
  return notes;
}

/** Analytics over a single pool-snapshot series (kept for single-pool runs). */
function summarizeSnapshots(rows: PoolSnapshot[]): string[] {
  const notes: string[] = [];
  if (rows.length < 2) {
    notes.push("fewer than 2 snapshots — no interval analytics yet");
    return notes;
  }
  const spanH = (rows[rows.length - 1].t - rows[0].t) / 3600;
  notes.push(`span ${spanH.toFixed(1)} h`);

  const tvls = rows
    .map((r) => snapshotTvlQuote(r, 9, 6))
    .filter((v): v is number => v !== null);
  if (tvls.length > 0) {
    notes.push(
      `on-chain TVL $${Math.min(...tvls).toFixed(0)} – $${Math.max(...tvls).toFixed(0)} ` +
        `(${tvls.length}/${rows.length} rows carry vault balances)`,
    );
  } else {
    notes.push("no vault balances captured yet (TVL history starts with newer rows)");
  }

  const prices = rows.map((r) => r.price);
  notes.push(`price $${Math.min(...prices).toFixed(2)} – $${Math.max(...prices).toFixed(2)}`);

  // Exact fee yield a ±5% range around the first price would have earned,
  // per unit of liquidity — the headline use of this dataset.
  const s0 = prices[0];
  const y = computeRangeFeeYield(rows, s0 * 0.95, s0 * 1.05, 1_000_000_000n);
  const usd = rangeYieldUsd(y, s0, 9, 6);
  if (y.totalSeconds > 0) {
    notes.push(
      `exact fees for L=1e9 in ±5% of $${s0.toFixed(2)}: $${usd.toFixed(6)} ` +
        `over ${(y.totalSeconds / 3600).toFixed(1)} h ` +
        `(in range ${((y.inRangeSeconds / y.totalSeconds) * 100).toFixed(0)}%)`,
    );
  }
  return notes;
}

export interface ReportInputs {
  /** Directory holding *.snapshots.jsonl (pool fee-growth + TVL). */
  snapshotDir?: string;
  /** Directory holding the web app's .data ledgers. */
  webDataDir?: string;
}

export function buildDataReport(inputs: ReportInputs, nowIso: string): DataReport {
  const datasets: DatasetSummary[] = [];
  const attachments: ReportAttachment[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  const addRows = (
    name: string,
    filename: string,
    rows: Record<string, unknown>[],
    notes: string[] = [],
  ) => {
    const csv = rowsToCsv(rows);
    const bytes = Buffer.byteLength(csv, "utf8");
    const stamps = rows.map(isoOf).filter((v): v is string => v !== null);
    datasets.push({
      name,
      file: filename,
      rows: rows.length,
      bytes,
      firstTs: stamps[0] ?? null,
      lastTs: stamps[stamps.length - 1] ?? null,
      notes,
    });
    if (bytes > MAX_ATTACHMENT_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) {
      skipped.push(`${filename} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
    attachments.push({
      filename,
      content: Buffer.from(csv, "utf8").toString("base64"),
      bytes,
    });
    totalBytes += bytes;
  };

  const addFile = (
    name: string,
    file: string,
    notes: string[] = [],
    enrich?: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
  ) => {
    if (!fs.existsSync(file)) return;
    const rows = readJsonl(file);
    const csvRows = enrich
      ? enrich(rows as Record<string, unknown>[])
      : (rows as Record<string, unknown>[]);
    const csv = rowsToCsv(csvRows);
    const bytes = Buffer.byteLength(csv, "utf8");
    const stamps = rows.map(isoOf).filter((v): v is string => v !== null);
    datasets.push({
      name,
      file: path.basename(file),
      rows: rows.length,
      bytes,
      firstTs: stamps[0] ?? null,
      lastTs: stamps[stamps.length - 1] ?? null,
      notes,
    });
    if (bytes > MAX_ATTACHMENT_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) {
      skipped.push(`${path.basename(file)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
    attachments.push({
      filename: path.basename(file).replace(/\.jsonl$/, "") + ".csv",
      content: Buffer.from(csv, "utf8").toString("base64"),
      bytes,
    });
    totalBytes += bytes;
  };

  // ── All pools in ONE long-format CSV with a `pool` column ──────────
  if (inputs.snapshotDir && fs.existsSync(inputs.snapshotDir)) {
    const meta = loadTrackedMeta(inputs.snapshotDir);
    const files = fs
      .readdirSync(inputs.snapshotDir)
      .filter((f) => f.endsWith(".snapshots.jsonl"));

    const merged: Record<string, unknown>[] = [];
    const perPool: { address: string; rows: PoolSnapshot[] }[] = [];
    for (const f of files) {
      const address = f.replace(".snapshots.jsonl", "");
      const rows = readJsonl(path.join(inputs.snapshotDir, f)) as PoolSnapshot[];
      if (rows.length === 0) continue;
      perPool.push({ address, rows });
      const m = meta.get(address);
      const decA = m?.decimalsA ?? 9;
      const decB = m?.decimalsB ?? 6;
      for (const r of rows) {
        const tvl = snapshotTvlQuote(r, decA, decB);
        merged.push({
          pool: address,
          pair: m ? `${m.symbolA}/${m.symbolB}` : "",
          t: r.t,
          iso: new Date(r.t * 1000).toISOString(),
          price: r.price,
          liquidity: r.liquidity,
          feeGrowthGlobalA: r.feeGrowthGlobalA,
          feeGrowthGlobalB: r.feeGrowthGlobalB,
          vaultA: r.vaultA ?? "",
          vaultB: r.vaultB ?? "",
          decimalsA: decA,
          decimalsB: decB,
          // TVL in QUOTE-token units; USD only when quoteIsUsd is true.
          tvlQuote: tvl ?? "",
          quoteIsUsd: m ? isUsdQuote(m.quoteMint) : "",
        });
      }
    }

    if (merged.length > 0) {
      merged.sort((a, b) =>
        (a.pool as string).localeCompare(b.pool as string) ||
        (a.t as number) - (b.t as number),
      );
      addRows(
        `Pool snapshots — ${perPool.length} pools consolidated`,
        "pool-snapshots.csv",
        merged,
        summarizeAllPools(perPool, meta),
      );
    }
  }
  if (inputs.webDataDir && fs.existsSync(inputs.webDataDir)) {
    const d = inputs.webDataDir;
    addFile("Pool overview (vendor volume/TVL)", path.join(d, "pool-overview.jsonl"));
    addFile("In-range estimator predictions", path.join(d, "inrange-predictions.jsonl"));
    addFile("Certificate ledger events", path.join(d, "hedge-events.jsonl"));
    // AUDIT #8: the order ledger was attached to nothing. A 200 USDC
    // pre-order is delivered BY HAND and a wrong-amount payment must be
    // refunded by hand — both were recorded only in a JSONL file inside a
    // Docker volume that no report read and no endpoint exposed. Money
    // taken with nobody told.
    addFile("Order ledger events (refunds + pre-orders to deliver)",
      path.join(d, "order-events.jsonl"));
  }

  // Operator action list, derived from the order ledger the same way the
  // app would. Rebuilt from events so the job needs no shared state.
  const attention = summariseOrdersNeedingAttention(inputs.webDataDir);

  const totalRows = datasets.reduce((s, d) => s + d.rows, 0);
  const subject = `LH data export — ${datasets.length} dataset(s), ${totalRows} rows (${nowIso.slice(0, 10)})`;

  const lines: string[] = [`Liquidity Hedge — data export`, `Generated ${nowIso}`, ""];
  if (attention.length > 0) {
    lines.push("** ACTION REQUIRED **");
    for (const a of attention) lines.push(`  ${a}`);
    lines.push("");
  }
  for (const d of datasets) {
    lines.push(`${d.name}`);
    lines.push(`  file: ${d.file} · rows: ${d.rows} · size: ${(d.bytes / 1024).toFixed(1)} kB`);
    if (d.firstTs) lines.push(`  window: ${d.firstTs} → ${d.lastTs}`);
    for (const n of d.notes) lines.push(`  • ${n}`);
    lines.push("");
  }
  if (skipped.length > 0) lines.push(`Not attached (size): ${skipped.join(", ")}`, "");
  lines.push("Data is attached as CSV. Generated by @lh/ops-jobs data-report.");
  const text = lines.join("\n");

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.55">` +
    `<h2 style="margin:0 0 4px">Liquidity Hedge — data export</h2>` +
    `<p style="color:#666;margin:0 0 16px">Generated ${esc(nowIso)}</p>` +
    datasets
      .map(
        (d) =>
          `<div style="margin:0 0 14px;padding:10px 12px;border:1px solid #e5e5e5;border-radius:8px">` +
          `<div style="font-weight:600">${esc(d.name)}</div>` +
          `<div style="color:#666">${esc(d.file)} · ${d.rows} rows · ${(d.bytes / 1024).toFixed(1)} kB</div>` +
          (d.firstTs ? `<div style="color:#666">${esc(d.firstTs)} → ${esc(d.lastTs ?? "")}</div>` : "") +
          (d.notes.length
            ? `<ul style="margin:8px 0 0;padding-left:18px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
            : "") +
          `</div>`,
      )
      .join("") +
    (skipped.length
      ? `<p style="color:#a15c00">Not attached (size): ${esc(skipped.join(", "))}</p>`
      : "") +
    `<p style="color:#666">Data is attached as CSV (one file per dataset).</p></div>`;

  return { generatedAt: nowIso, datasets, attachments, subject, text, html, skipped };
}
/**
 * Orders awaiting a human: refunds due, and paid pre-orders to deliver.
 *
 * AUDIT #8: `OrderLedger.needsAttention()` existed and was called by
 * nothing, so neither case ever reached an operator. Replayed here from
 * the event log rather than importing the live ledger, so the reporting
 * job stays read-only and needs no shared process state.
 */
export function summariseOrdersNeedingAttention(dir: string | undefined): string[] {
  if (!dir) return [];
  const file = path.join(dir, "order-events.jsonl");
  if (!fs.existsSync(file)) return [];
  const state = new Map<string, { status: string; amount: number; product: string }>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    // OrderCreated nests the id under `order`; every later event carries
    // it at the top level.
    const nested = (e.order ?? {}) as Record<string, unknown>;
    const id = String(e.orderId ?? nested.orderId ?? "");
    if (!id) continue;
    const prev = state.get(id) ?? { status: "", amount: 0, product: "" };
    switch (e.kind) {
      case "OrderCreated": {
        // The order's fields are NESTED under `e.order`; reading them from
        // the top level left every entry at 0.000000 USDC with an empty
        // product, so a 200 USDC pre-order and a $1.03 refund looked
        // identical on the operator's action list.
        const order = (e.order ?? {}) as Record<string, unknown>;
        state.set(id, {
          status: "awaiting-payment",
          amount: Number(order.amountUsdc ?? 0),
          product: String(order.productId ?? ""),
        });
        break;
      }
      case "PaymentObserved": state.set(id, { ...prev, status: "paid" }); break;
      // The ledger emits OrderFulfilled / OrderExpired — matching the
      // shorter names meant fulfilled orders NEVER cleared from the list.
      case "OrderFulfilled":  state.set(id, { ...prev, status: "fulfilled" }); break;
      case "OrderExpired":    state.set(id, { ...prev, status: "expired" }); break;
      case "RefundDue":       state.set(id, { ...prev, status: "refund-due" }); break;
      // NOTE: the ledger has no "refund paid" event, so a refund-due order
      // stays on this list until one exists. That is the right default —
      // an unresolved refund should remain visible — but it does mean the
      // list cannot be cleared by paying the refund. Tracked as an open item.
      default: break;
    }
  }
  const out: string[] = [];
  for (const [id, o] of state) {
    if (o.status === "refund-due") {
      out.push(`REFUND DUE  order ${id}  ${(o.amount / 1e6).toFixed(6)} USDC  (${o.product})`);
    } else if (o.status === "paid") {
      out.push(`DELIVER     order ${id}  ${(o.amount / 1e6).toFixed(6)} USDC  (${o.product}) — paid, awaiting manual delivery`);
    }
  }
  return out;
}
