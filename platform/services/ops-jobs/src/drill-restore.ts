#!/usr/bin/env ts-node
/**
 * RB-6 restore drill: load a certificate-ledger event log and verify it
 * replays to a valid state (invariants I1–I4 green). Non-zero exit on any
 * failure — wire into the quarterly drill and post-restore checks.
 *
 * Usage: pnpm --filter @lh/ops-jobs drill-restore <path/to/hedge-events.jsonl>
 */

import { readFileSync } from "fs";
import { CertificateLedger, sha256Hex, LedgerConfig } from "@lh/hedge";

const file = process.argv[2];
if (!file) {
  console.error("usage: drill-restore <hedge-events.jsonl> [master-terms-hash]");
  process.exit(1);
}

// Config values do not affect replay validity (events are facts), but the
// shape must be complete; hash defaults to draft for drills.
const config: LedgerConfig = {
  uMaxBps: 3000, protocolFeeBps: 150, premiumFloorUsdc: 1_500_000,
  markupFloor: 1.05, feeSplitRate: 0.1, expectedDailyFee: 0.005,
  tenorSeconds: 604_800, quoteTtlSeconds: 120, regimeMaxAgeSeconds: 900,
  perBuyerCapDownLimitUsdc: 0,
  masterTermsVersion: "drill", masterTermsHash: process.argv[3] ?? sha256Hex("drill"),
  treasuryAddress: "drill",
};

try {
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  const ledger = CertificateLedger.fromEvents(
    config,
    { now: () => Math.floor(Date.now() / 1000) },
    { quoteId: () => "drill", referenceKey: () => "drill" },
    events as never,
  );
  const st = ledger.getState();
  const mon = ledger.monitor();
  console.log(
    `RESTORE DRILL PASSED ✔  events=${events.length}  quotes=${st.quotes.size}  ` +
      `payments=${st.paymentsByTx.size}  certs=${st.certs.size}  ` +
      `treasury=$${(st.treasuryUsdc / 1e6).toFixed(2)}  invariants=${mon.invariants.ok}`,
  );
  if (!mon.invariants.ok) process.exit(3);
} catch (e) {
  console.error("RESTORE DRILL FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
}
