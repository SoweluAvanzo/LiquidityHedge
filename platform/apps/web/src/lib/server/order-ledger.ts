/**
 * Data-product order ledger: process-wide singleton, event-sourced to
 * JSONL (same pattern as the hedge ledger — single writer behind a
 * promise-chain mutex, replayed on boot).
 *
 * Security posture:
 *  - the revenue wallet is EXTERNALLY managed; this process holds no keys
 *    for it and can only observe inbound payments;
 *  - fulfilment happens only after an on-chain payment is verified at
 *    `finalized` — never on a client assertion;
 *  - download grants are single-use, expiring, and stored hashed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import {
  CommerceConfig,
  OrderLedger,
  OrderEvent,
  PRODUCTS,
  ProductId,
} from "@lh/commerce";

const DATA_DIR = path.join(process.cwd(), ".data");
const EVENTS_FILE = path.join(DATA_DIR, "order-events.jsonl");

/** Mainnet USDC. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class CommerceUnavailableError extends Error {}

export function commerceConfig(): CommerceConfig {
  const revenueWallet = process.env.DATA_REVENUE_WALLET;
  if (!revenueWallet) {
    throw new CommerceUnavailableError("revenue wallet not configured");
  }
  // SECURITY (B2): the dataset revenue wallet and the hedge treasury MUST
  // be different addresses. Sharing one means the hedge watcher ingests
  // dataset payments as unmatched transfers — inflating treasury
  // reconciliation and AUTO-REFUNDING them while the file is delivered
  // (a free dataset). Fail closed rather than discover this in production.
  const treasury = process.env.HEDGE_TREASURY_ADDRESS;
  if (treasury && treasury === revenueWallet) {
    throw new CommerceUnavailableError(
      "DATA_REVENUE_WALLET must differ from HEDGE_TREASURY_ADDRESS " +
        "(shared wallets cause dataset payments to be auto-refunded)",
    );
  }
  return {
    revenueWallet,
    usdcMint: process.env.USDC_MINT ?? USDC_MINT,
    orderTtlSeconds: Number(process.env.ORDER_TTL_SECONDS ?? 3600),
    downloadTtlSeconds: Number(process.env.DOWNLOAD_TTL_SECONDS ?? 86_400),
    minRefundUsdc: Number(process.env.MIN_REFUND_USDC ?? 500_000),
  };
}

interface Singleton {
  ledger: OrderLedger;
  persistedCount: number;
  queue: Promise<unknown>;
}

const KEY = Symbol.for("lh.order-ledger");
type GlobalWithLedger = typeof globalThis & { [KEY]?: Singleton };

function boot(): Singleton {
  const config = commerceConfig();
  const clock = { now: () => Math.floor(Date.now() / 1000) };
  mkdirSync(DATA_DIR, { recursive: true });

  let ledger: OrderLedger;
  let persistedCount = 0;
  if (existsSync(EVENTS_FILE)) {
    const events = readFileSync(EVENTS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as OrderEvent);
    ledger = OrderLedger.fromEvents(config, clock, events);
    persistedCount = events.length;
  } else {
    ledger = new OrderLedger(config, clock);
  }
  return { ledger, persistedCount, queue: Promise.resolve() };
}

function singleton(): Singleton {
  const g = globalThis as GlobalWithLedger;
  if (!g[KEY]) g[KEY] = boot();
  return g[KEY]!;
}

function persist(s: Singleton): void {
  const events = s.ledger.getEvents();
  if (events.length <= s.persistedCount) return;
  const lines = events
    .slice(s.persistedCount)
    .map((e) => JSON.stringify(e))
    .join("\n");
  appendFileSync(EVENTS_FILE, lines + "\n");
  s.persistedCount = events.length;
}

/** Single-writer access: exactly one mutation (and flush) at a time. */
export function withOrders<T>(fn: (ledger: OrderLedger) => T | Promise<T>): Promise<T> {
  const s = singleton();
  const run = s.queue.then(async () => {
    const result = await fn(s.ledger);
    persist(s);
    return result;
  });
  // Keep the chain alive even if this call rejects.
  s.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isProductId(v: unknown): v is ProductId {
  return typeof v === "string" && v in PRODUCTS;
}
