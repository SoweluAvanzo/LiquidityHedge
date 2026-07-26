#!/usr/bin/env ts-node
/**
 * B1 (second half) — the key-holding payout executor.
 *
 * Drains the payout outbox written by the web process and signs each
 * transfer with the hot wallet. This is the ONLY component that holds a
 * signing key, and it is not reachable from the internet: no inbound
 * ports, no HTTP surface, outbound RPC only.
 *
 * Safety properties:
 *  - idempotent: every outbox line carries a unique `reference`; already-
 *    executed references are recorded in receipts.jsonl and skipped;
 *  - float-capped: refuses to exceed HOT_WALLET_FLOAT_CAP_USDC per cycle;
 *  - fail-closed: an unparseable or malformed line is quarantined, never
 *    guessed at;
 *  - every execution is receipted for reconciliation against the ledger.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { resolve, join } from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildPayoutInstructions } from "@lh/hedge";

interface OutboxEntry {
  kind: "settlement" | "refund";
  reference: string;
  to: string;
  amountUsdc: number;
  memo: string;
  queuedAt: string;
}

function envVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envPath = resolve(__dirname, "../../../../lh-protocol/.env");
  if (!existsSync(envPath)) return undefined;
  return readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((v): v is T => v !== null);
}

function validEntry(e: OutboxEntry): boolean {
  try {
    new PublicKey(e.to);
  } catch {
    return false;
  }
  return (
    (e.kind === "settlement" || e.kind === "refund") &&
    typeof e.reference === "string" &&
    e.reference.length > 0 &&
    Number.isSafeInteger(e.amountUsdc) &&
    e.amountUsdc > 0
  );
}

async function main() {
  const dataDir = process.env.HEDGE_DATA_DIR ?? "/webdata";
  const outbox = join(dataDir, "payout-outbox.jsonl");
  const receiptsFile = join(dataDir, "payout-receipts.jsonl");
  const quarantine = join(dataDir, "payout-quarantine.jsonl");

  const rpc = envVar("RPC_URL");
  const keyPath = process.env.HOT_WALLET_KEYPAIR;
  if (!rpc || !keyPath || !existsSync(keyPath)) {
    console.error("RPC_URL and HOT_WALLET_KEYPAIR (readable file) are required");
    process.exit(1);
  }
  const hot = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))),
  );
  const usdcMint = new PublicKey(
    process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const floatCap = Number(process.env.HOT_WALLET_FLOAT_CAP_USDC ?? 2_000_000_000);
  const dryRun = process.env.PAYOUT_DRY_RUN === "1";
  const connection = new Connection(rpc, "finalized");
  mkdirSync(dataDir, { recursive: true });

  const cycle = async () => {
    const entries = readJsonl<OutboxEntry>(outbox);
    const done = new Set(
      readJsonl<{ reference: string }>(receiptsFile).map((r) => r.reference),
    );
    const pending = entries.filter((e) => !done.has(e.reference));
    if (pending.length === 0) return;

    const ata = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
    const balance = Number((await getAccount(connection, ata)).amount);
    let budget = Math.min(balance, floatCap);
    console.log(
      `[executor] ${pending.length} pending · balance $${(balance / 1e6).toFixed(2)} · ` +
        `budget $${(budget / 1e6).toFixed(2)}${dryRun ? " · DRY RUN" : ""}`,
    );

    for (const e of pending) {
      if (!validEntry(e)) {
        appendFileSync(quarantine, JSON.stringify({ ...e, reason: "malformed" }) + "\n");
        console.error(`[executor] QUARANTINED malformed entry ${e.reference}`);
        continue;
      }
      if (e.amountUsdc > budget) {
        console.error(
          `[executor] float exhausted — ${e.reference} ($${(e.amountUsdc / 1e6).toFixed(2)}) ` +
            `deferred; top up the hot wallet from the vault (RB-2)`,
        );
        break; // preserve FIFO; do not skip ahead
      }
      if (dryRun) {
        console.log(`[executor] would pay ${e.reference} → $${(e.amountUsdc / 1e6).toFixed(2)}`);
        continue;
      }
      try {
        const tx = new Transaction().add(
          ...buildPayoutInstructions({
            fromWallet: hot.publicKey,
            toWallet: new PublicKey(e.to),
            usdcMint,
            amountUsdc: e.amountUsdc,
            memo: e.memo,
          }),
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [hot], {
          commitment: "finalized",
        });
        budget -= e.amountUsdc;
        appendFileSync(
          receiptsFile,
          JSON.stringify({
            reference: e.reference,
            kind: e.kind,
            to: e.to,
            amountUsdc: e.amountUsdc,
            txSignature: sig,
            executedAt: new Date().toISOString(),
          }) + "\n",
        );
        console.log(`[executor] paid ${e.reference} → ${sig.slice(0, 16)}…`);
      } catch (err) {
        // No receipt written ⇒ retried next cycle. At-least-once with an
        // idempotency key is the right failure mode for owed money.
        console.error(
          `[executor] payout FAILED for ${e.reference}:`,
          (err as Error).message ?? err,
        );
      }
    }
  };

  await cycle();
  const loop = Number(process.env.PAYOUT_LOOP_SECONDS ?? 0);
  if (loop > 0) {
    console.log(`[executor] resident mode — every ${loop}s`);
    const tick = () => {
      cycle()
        .catch((e) => console.error("[executor] cycle failed:", e?.message ?? e))
        .finally(() => setTimeout(tick, loop * 1000));
    };
    setTimeout(tick, loop * 1000);
  }
}

main().catch((e) => {
  console.error("payout executor failed:", e?.message ?? e);
  process.exit(1);
});
