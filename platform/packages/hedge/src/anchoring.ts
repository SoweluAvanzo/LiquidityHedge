/**
 * On-chain anchoring via the SPL Memo program (AR-6 — existing programs
 * only, tx-fee cost). Anchors: T&C/master-terms hashes, per-certificate
 * term-sheet hashes at activation, and the daily Merkle root of the audit
 * event log (NFR-A1). Verification always recomputes from our ledger; the
 * memo is a public commitment, not a source of truth.
 */

import { createHash } from "crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export type AnchorPayload =
  | { t: "lh-terms"; version: string; hash: string }
  | { t: "lh-cert"; quoteId: string; termSheetHash: string }
  | { t: "lh-audit-root"; date: string; root: string; count: number };

export function buildAnchorMemoIx(
  payload: AnchorPayload,
  signer: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(JSON.stringify(payload), "utf8"),
  });
}

// ── Merkle root over audit events ───────────────────────────────────

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Merkle root of the given leaf hashes (hex). Odd nodes are promoted
 * unchanged (Bitcoin-style duplication is avoided deliberately — no
 * ambiguity between a leaf and its duplicate).
 */
export function merkleRoot(leafHashesHex: string[]): string {
  if (leafHashesHex.length === 0) return sha256Hex("lh-empty");
  let level = leafHashesHex;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256Hex(level[i] + level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
  }
  return level[0];
}

export function eventLeafHash(eventJson: string): string {
  return sha256Hex(eventJson);
}
