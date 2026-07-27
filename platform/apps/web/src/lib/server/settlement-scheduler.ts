/**
 * B1 — the production payment watcher / settler.
 *
 * ARCHITECTURE NOTE (why it lives in this process):
 * the certificate ledger has exactly ONE writer by design — the promise-
 * chain mutex in hedge-ledger.ts. Quoting happens here, so settlement must
 * happen here too; a second process mutating the same JSONL would corrupt
 * it. What this scheduler does NOT do is sign anything: it runs the cycle
 * in `dryRun` and writes planned payouts to an OUTBOX. A separate
 * key-holding service (services/ops-jobs/src/payout-executor.ts) drains
 * the outbox and signs. The hot-wallet key therefore never exists in the
 * internet-facing container.
 *
 *   web (this process)          payout-executor (isolated, holds the key)
 *   ├─ observe payments  ─────────────────────────────────────────┐
 *   ├─ activate certificates                                      │
 *   ├─ settle expired  ──► payout-outbox.jsonl ──► sign & send ───┘
 *   └─ single ledger writer                        receipts.jsonl
 */

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  runSettlementCycle,
  scanTreasuryPayments,
  type CertificateRecord,
  type RunnerPorts,
  type SettlementPriceReading,
} from "@lh/hedge";
import { getHedgeConfig, withHedge, HedgeUnavailableError } from "./hedge-ledger";

const DATA_DIR = path.join(process.cwd(), ".data");
const OUTBOX = path.join(DATA_DIR, "payout-outbox.jsonl");

let cursor: string | null = null;
let running = false;

/** Settlement price policy (AR-7): pool price + independent cross-check. */
async function readSettlementPrice(
  connection: Connection,
  cert: CertificateRecord,
): Promise<SettlementPriceReading> {
  const { decodeWhirlpoolAccount, sqrtPriceX64ToPrice } = await import(
    "@lh/core/src/market-data/decoder"
  );
  const quote = await withHedge((l) => l.getState().quotes.get(cert.quoteId));
  if (!quote) throw new Error(`no quote for ${cert.quoteId}`);
  const info = await connection.getAccountInfo(new PublicKey(quote.position.whirlpool), {
    commitment: "finalized",
  });
  if (!info) throw new Error("whirlpool account unreadable at settlement");
  const pool = decodeWhirlpoolAccount(info.data);
  const price = sqrtPriceX64ToPrice(
    pool.sqrtPrice,
    quote.position.decimalsA,
    quote.position.decimalsB,
  );
  const slot = await connection.getSlot("finalized");

  // Cross-check against the vendor price; a wide divergence defers
  // settlement rather than settling on a possibly manipulated quote.
  let crossCheck = price;
  try {
    const { getPoolOverview } = await import("./birdeye");
    const overview = await getPoolOverview(
      quote.position.whirlpool,
      pool.feeRate / 1_000_000, // u16 hundredths of a bp → decimal
    );
    if (overview?.priceUsd && overview.priceUsd > 0) crossCheck = overview.priceUsd;
  } catch {
    /* vendor unavailable → divergence 0, pool price stands */
  }
  const divergenceBps =
    crossCheck > 0 ? Math.abs(price - crossCheck) / crossCheck * 10_000 : 0;
  return { priceUsd: price, slot, crossCheckPriceUsd: crossCheck, divergenceBps };
}

function queuePayout(entry: Record<string, unknown>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(OUTBOX, JSON.stringify({ ...entry, queuedAt: new Date().toISOString() }) + "\n");
}

/** One cycle. Safe to call repeatedly; never overlaps itself. */
export async function runCycleOnce(): Promise<{ ok: boolean; summary: string }> {
  if (running) return { ok: true, summary: "skipped (cycle already running)" };
  running = true;
  try {
    const config = getHedgeConfig();
    const connection = new Connection(
      process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
      "finalized",
    );
    const usdcMint = new PublicKey(
      process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    const treasuryAta = getAssociatedTokenAddressSync(
      usdcMint,
      new PublicKey(config.treasuryAddress),
    );

    const ports: RunnerPorts = {
      scanPayments: async (until) => {
        const r = await scanTreasuryPayments(connection, treasuryAta, usdcMint, {
          untilSignature: until ?? undefined,
        });
        return { transfers: r.transfers, cursor: r.cursor };
      },
      readSettlementPrice: (cert) => readSettlementPrice(connection, cert),
      // AUDIT #4: this is a STUB, not a fallback. The port doc says
      // implementations must return 0 *on data failure*; here there is no
      // primary reader at all — the real one (core's fee-refresher) was
      // never wired to @lh/hedge. Returning 0 is buyer-favourable and safe
      // in itself, but the premium must not be discounted for a fee split
      // that will never be collected, so `feeSplitRate` is pinned to 0 in
      // hedge-ledger's buildConfig(). The assertion below keeps the two
      // facts welded together.
      readAccruedFees: async () => 0,
      // dryRun is always true here — this process never signs.
      executePayout: async () => {
        throw new Error("web process must never sign payouts");
      },
      hotWalletBalanceUsdc: async () => {
        const bal = await connection.getTokenAccountBalance(treasuryAta, "finalized");
        return Number(bal.value.amount);
      },
    };

    const report = await withHedge((ledger) =>
      runSettlementCycle(
        ledger,
        ports,
        {
          hotWalletFloatCapUsdc: Number(process.env.HOT_WALLET_FLOAT_CAP_USDC ?? 2_000_000_000),
          minRefundUsdc: Number(process.env.MIN_REFUND_USDC ?? 500_000),
          maxDivergenceBps: Number(process.env.MAX_DIVERGENCE_BPS ?? 100),
          dryRun: true, // plan only — the executor signs
        },
        cursor,
      ),
    );
    cursor = report.cursor;

    for (const p of [...report.settled, ...report.refunded]) {
      if (p.amountUsdc > 0) {
        queuePayout({
          kind: p.kind,
          reference: p.reference,
          to: p.to,
          amountUsdc: p.amountUsdc,
          memo: `${p.kind === "settlement" ? "settle" : "refund"}:${p.reference}`,
        });
      }
    }

    const summary =
      `observed=${report.observedPayments} activated=${report.activated.length} ` +
      `settled=${report.settled.length} refunds=${report.refunded.length} ` +
      `deferred=${report.deferredForDivergence.length} dust=${report.dustSkipped.length} ` +
      `shortfall=${report.floatShortfallUsdc ?? 0} invariants=${report.invariantsOk}`;
    if (!report.invariantsOk) console.error("[settler] INVARIANT VIOLATION —", summary);
    return { ok: report.invariantsOk, summary };
  } finally {
    running = false;
  }
}

/** Start the resident loop (called once at boot when hedging is enabled). */
export function startSettlementScheduler(): void {
  const seconds = Number(process.env.SETTLEMENT_INTERVAL_SECONDS ?? 60);
  if (seconds <= 0) return;
  let cfg;
  try {
    cfg = getHedgeConfig();
  } catch (e) {
    if (e instanceof HedgeUnavailableError) return; // hedging disabled
    throw e;
  }

  // AUDIT #4: a non-zero fee split means the premium was discounted for
  // revenue the settlement path is supposed to collect. `readAccruedFees`
  // above returns 0 unconditionally, so that revenue cannot arrive.
  // Selling at a discount for income that structurally never comes is a
  // loss on every certificate — refuse to run rather than bleed quietly.
  if (cfg.feeSplitRate > 0) {
    throw new Error(
      `feeSplitRate is ${cfg.feeSplitRate} but readAccruedFees is a stub that ` +
        `always returns 0 — the premium would be discounted for fee revenue ` +
        `that is never collected. Wire a real fee-growth reader before ` +
        `setting HEDGE_FEE_SPLIT_RATE above zero.`,
    );
  }
  const tick = () => {
    runCycleOnce()
      .then((r) => console.log(`[settler] ${r.summary}`))
      .catch((e) => console.error("[settler] cycle failed:", e?.message ?? e))
      .finally(() => setTimeout(tick, seconds * 1000));
  };
  console.log(`[settler] watcher started — every ${seconds}s (planning only, never signs)`);
  setTimeout(tick, 5_000);
}
