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
import { numericEnv } from "@lh/storage";
import {
  readFeeCheckpoint,
  readAccruedFees as readAccruedFeesImpl,
} from "./fee-reader";

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
  // C3: price and slot from ONE finalized response — the previous
  // separate getSlot() could pair a price with a later slot, making the
  // archived "price at slot N" claim unverifiable.
  const { context, value: info } = await connection.getAccountInfoAndContext(
    new PublicKey(quote.position.whirlpool),
    { commitment: "finalized" },
  );
  if (!info) throw new Error("whirlpool account unreadable at settlement");
  const pool = decodeWhirlpoolAccount(info.data);
  const price = sqrtPriceX64ToPrice(
    pool.sqrtPrice,
    quote.position.decimalsA,
    quote.position.decimalsB,
  );
  const slot = context.slot;

  // C2: the §7.1 divergence guard must not disable itself precisely when
  // it is needed. A missing/unusable cross-check REFUSES to settle (the
  // sentinel divergence routes into the runner's defer path) — it never
  // writes an archive record asserting an independent source agreed.
  try {
    const { getPoolOverview } = await import("./birdeye");
    const overview = await getPoolOverview(
      quote.position.whirlpool,
      pool.feeRate / 1_000_000, // u16 hundredths of a bp → decimal
    );
    if (!(overview?.priceUsd && overview.priceUsd > 0)) {
      throw new Error("vendor returned no usable price");
    }
    const crossCheck = overview.priceUsd;
    return {
      priceUsd: price,
      slot,
      crossCheckPriceUsd: crossCheck,
      divergenceBps: (Math.abs(price - crossCheck) / crossCheck) * 10_000,
      crossCheckSource: "birdeye",
    };
  } catch (error) {
    console.warn(
      `[settler] cross-check unavailable for ${cert.quoteId} — deferring ` +
        `settlement (${error instanceof Error ? error.message : error})`,
    );
    return {
      priceUsd: price,
      slot,
      crossCheckPriceUsd: 0,
      divergenceBps: Number.MAX_SAFE_INTEGER,
      crossCheckSource: "unavailable",
    };
  }
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
      process.env.USDC_MINT?.trim() || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // "" = unset (audit 0.1)
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
      readFeeCheckpoint: (positionMint) =>
        readFeeCheckpoint(connection, positionMint),
      // AUDIT #4, now a REAL reader. The RT's share is y x the LP fees
      // accrued DURING the certificate, so this is the delta of the
      // position's fee-growth-inside between the activation checkpoint and
      // now — exactly the quantity the Whirlpool program itself would pay
      // out on a collect. Token A is valued at the settlement price; token
      // B is the USDC leg.
      //
      // Returns 0 on ANY data failure, per the port contract: a missing
      // checkpoint, an unreadable position, or an unusable price all mean
      // "no fee share", which is buyer-favourable. It never estimates.
      readAccruedFees: async (cert) => {
        const p = await readSettlementPrice(connection, cert).catch(() => null);
        return readAccruedFeesImpl(connection, cert, p?.priceUsd);
      },
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
          hotWalletFloatCapUsdc: numericEnv("HOT_WALLET_FLOAT_CAP_USDC", 2_000_000_000),
          minRefundUsdc: numericEnv("MIN_REFUND_USDC", 500_000),
          maxDivergenceBps: numericEnv("MAX_DIVERGENCE_BPS", 100),
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
  const seconds = numericEnv("SETTLEMENT_INTERVAL_SECONDS", 60);
  if (seconds <= 0) return;
  try {
    getHedgeConfig(); // availability probe — throws when hedging is disabled
  } catch (e) {
    if (e instanceof HedgeUnavailableError) return;
    throw e;
  }

  // AUDIT #4 is now closed: `readAccruedFees` above reads real
  // fee-growth deltas, so a non-zero fee split is backed by revenue the
  // settlement path actually collects. The assertion that used to refuse
  // a non-zero split is gone with the stub it guarded.
  const tick = () => {
    runCycleOnce()
      .then((r) => console.log(`[settler] ${r.summary}`))
      .catch((e) => console.error("[settler] cycle failed:", e?.message ?? e))
      .finally(() => setTimeout(tick, seconds * 1000));
  };
  console.log(`[settler] watcher started — every ${seconds}s (planning only, never signs)`);
  setTimeout(tick, 5_000);
}
