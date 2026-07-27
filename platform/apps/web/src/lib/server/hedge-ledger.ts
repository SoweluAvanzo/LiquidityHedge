/**
 * Process-wide hedge ledger singleton (server-only).
 *
 * The event-sourced `CertificateLedger` from @lh/hedge is held once per
 * process (survives dev HMR via globalThis) and persisted as JSONL at
 * `<app>/.data/hedge-events.jsonl`: on first access an existing log is
 * replayed via `CertificateLedger.fromEvents` (invariants re-checked on
 * every applied event), otherwise a fresh ledger is opened with
 * HEDGE_INITIAL_RESERVES_USDC. After every mutating call the events
 * beyond the previously persisted count are appended — the log on disk
 * is always a prefix-complete history.
 *
 * All ledger access goes through `withHedge`, a module-level
 * promise-chain mutex: exactly one caller mutates (and persists) at a
 * time — the single-writer discipline the ledger's event log assumes.
 */

import { randomBytes, randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import {
  CertificateLedger,
  sha256Hex,
  type LedgerConfig,
  type LedgerEvent,
} from "@lh/hedge";

/** Raised when required server configuration is missing → HTTP 503. */
export class HedgeUnavailableError extends Error {}

const DATA_DIR = path.join(process.cwd(), ".data");
const EVENTS_PATH = path.join(DATA_DIR, "hedge-events.jsonl");

const MASTER_TERMS_RELPATH = path.join(
  "product-design",
  "legal",
  "02_master_hedging_terms.md",
);
const TERM_SHEET_TEMPLATE_RELPATH = path.join(
  "product-design",
  "legal",
  "03_certificate_term_sheet_template.md",
);

/** Repo root = nearest ancestor of cwd that contains the legal corpus. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, MASTER_TERMS_RELPATH))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `repo root not found: no ${MASTER_TERMS_RELPATH} above ${process.cwd()}`,
  );
}

/**
 * The six purchase acknowledgments, read VERBATIM from the term-sheet
 * template's "Key acknowledgments" section (legal doc 03). Markdown
 * emphasis/backticks are stripped for plain-text display and the
 * `{version}` placeholder is filled with the Master Terms version.
 */
function parseConsentItems(markdown: string, version: string): string[] {
  const section = markdown.split(/^## Key acknowledgments.*$/m)[1];
  if (!section) {
    throw new Error(
      "Key acknowledgments section not found in the term-sheet template",
    );
  }
  const items: string[] = [];
  for (const line of section.split("\n")) {
    const start = /^- \[ \] (.*)$/.exec(line);
    if (start) {
      items.push(start[1].trim());
    } else if (items.length > 0 && /^\s+\S/.test(line)) {
      // Indented continuation of the previous checkbox item.
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  const cleaned = items.map((text) =>
    text
      .replace(/`\{version\}`/g, version)
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .trim(),
  );
  if (cleaned.length !== 6) {
    throw new Error(
      `expected 6 acknowledgment items in the template, found ${cleaned.length}`,
    );
  }
  return cleaned;
}

interface HedgeSingleton {
  ledger: CertificateLedger;
  config: LedgerConfig;
  consentItems: string[];
  /** Number of events already appended to the JSONL file. */
  persistedCount: number;
  /** Promise-chain mutex — single writer. */
  chain: Promise<unknown>;
}

// Survive Next.js dev-mode module reloads: exactly one ledger (and one
// file writer) per process, whatever the bundler does to module state.
const registry = globalThis as unknown as { __lhHedgeSingleton?: HedgeSingleton };

function buildConfig(): LedgerConfig {
  const treasuryAddress = process.env.HEDGE_TREASURY_ADDRESS?.trim();
  if (!treasuryAddress) {
    throw new HedgeUnavailableError("treasury not configured");
  }
  const masterTermsVersion = "0.1-draft";
  // Hash the governing Master Terms text once at startup — every term
  // sheet issued by this process cites this hash.
  const masterTerms = readFileSync(
    path.join(repoRoot(), MASTER_TERMS_RELPATH),
    "utf8",
  );
  return {
    uMaxBps: 3000,
    protocolFeeBps: 150,
    // Governance parameter (docs/03 §3.3): $0.05 default. A high floor makes
    // small positions uneconomical to hedge (it dominates the fair value);
    // override per environment with HEDGE_PREMIUM_FLOOR_USDC (µUSDC).
    premiumFloorUsdc: Number(process.env.HEDGE_PREMIUM_FLOOR_USDC ?? 50_000),
    // A2/A3 guards: bound griefing and unbounded ledger growth.
    maxOpenQuotesPerOwner: Number(process.env.MAX_OPEN_QUOTES_PER_OWNER ?? 3),
    maxLifetimeQuotes: Number(process.env.MAX_LIFETIME_QUOTES ?? 50_000),
    markupFloor: 1.05,
    // AUDIT #4: the premium formula discounts by `y · E[F]` BECAUSE the
    // Risk Taker collects y × realised LP fees at settlement. Every
    // production `readAccruedFees` returns 0 unconditionally (the real
    // fee-growth reader is never wired to @lh/hedge), so that revenue
    // never arrives — the discount was pure, structural loss: ~$35 given
    // away on a $10k position against $1 of protocol fee.
    //
    // Until a real reader is wired, the split is ZERO and the premium is
    // not discounted for it. Re-enable ONLY together with a reader that
    // actually returns accrued fees; the two must move as one.
    feeSplitRate: Number(process.env.HEDGE_FEE_SPLIT_RATE ?? 0),
    // AUDIT #5: this was hardcoded at 0.5%/day while the platform's own
    // live measurement of the canonical SOL/USDC pool is ~0.042%/day —
    // 12x. E[F] = V · expectedDailyFee · tenorDays feeds the same discount
    // above, so an inflated figure underprices the certificate. The
    // conservative governance default is now an order of magnitude lower
    // and overridable; a measurement-driven value is the proper fix
    // (computeInRangeDailyRate already exists in lib/server/viability).
    expectedDailyFee: Number(process.env.HEDGE_EXPECTED_DAILY_FEE ?? 0.0005),
    tenorSeconds: Number(process.env.HEDGE_TENOR_SECONDS ?? 604_800),
    quoteTtlSeconds: 120,
    regimeMaxAgeSeconds: 900,
    perBuyerCapDownLimitUsdc: Number(process.env.HEDGE_PER_BUYER_CAP_USDC ?? 0),
    masterTermsVersion,
    masterTermsHash: sha256Hex(masterTerms),
    treasuryAddress,
  };
}

function persistNewEvents(s: HedgeSingleton): void {
  const events = s.ledger.getEvents();
  if (events.length <= s.persistedCount) return;
  const lines = events
    .slice(s.persistedCount)
    .map((e) => `${JSON.stringify(e)}\n`)
    .join("");
  appendFileSync(EVENTS_PATH, lines, "utf8");
  s.persistedCount = events.length;
}

function init(): HedgeSingleton {
  const config = buildConfig();
  const template = readFileSync(
    path.join(repoRoot(), TERM_SHEET_TEMPLATE_RELPATH),
    "utf8",
  );
  const consentItems = parseConsentItems(template, config.masterTermsVersion);

  const clock = { now: () => Math.floor(Date.now() / 1000) };
  const ids = {
    quoteId: () => randomUUID(),
    referenceKey: () => `LH-${randomBytes(8).toString("hex")}`,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  let ledger: CertificateLedger;
  let persistedCount = 0;
  if (existsSync(EVENTS_PATH)) {
    const lines = readFileSync(EVENTS_PATH, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const events = lines.map((line) => JSON.parse(line) as LedgerEvent);
    // Replay FACTS from disk — a corrupted/tampered log fails loudly here.
    ledger = CertificateLedger.fromEvents(config, clock, ids, events);
    persistedCount = lines.length;
  } else {
    const initialReserves = Number(
      process.env.HEDGE_INITIAL_RESERVES_USDC ?? 100_000_000,
    );
    ledger = new CertificateLedger(config, clock, ids, initialReserves);
  }

  const singleton: HedgeSingleton = {
    ledger,
    config,
    consentItems,
    persistedCount,
    chain: Promise.resolve(),
  };
  // Fresh ledger: write LedgerOpened immediately; replayed ledger: no-op.
  persistNewEvents(singleton);
  return singleton;
}

function getSingleton(): HedgeSingleton {
  // Never cache a failed init (e.g. missing treasury env) — retry per call.
  if (!registry.__lhHedgeSingleton) {
    registry.__lhHedgeSingleton = init();
  }
  return registry.__lhHedgeSingleton;
}

/**
 * Serialized access to the ledger. Every call (read or write) runs after
 * all previously enqueued calls; any events the callback produced are
 * appended to the JSONL log before the result is returned.
 */
export async function withHedge<T>(
  fn: (ledger: CertificateLedger, config: LedgerConfig) => T | Promise<T>,
): Promise<T> {
  const s = getSingleton();
  const run = s.chain.then(async () => {
    try {
      return await fn(s.ledger, s.config);
    } finally {
      persistNewEvents(s);
    }
  });
  // Keep the chain alive when fn throws — errors surface to THIS caller only.
  s.chain = run.catch(() => undefined);
  return run;
}

/** Ledger configuration (throws HedgeUnavailableError when unconfigured). */
export function getHedgeConfig(): LedgerConfig {
  return getSingleton().config;
}

/** The six acknowledgment texts (legal doc 03, read at startup). */
export function getConsentItems(): string[] {
  return getSingleton().consentItems;
}

/** Dev-only endpoints are enabled only when HEDGE_DEV_MODE === "1". */
export function hedgeDevMode(): boolean {
  return process.env.HEDGE_DEV_MODE === "1";
}
