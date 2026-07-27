/**
 * Proof of wallet control, for endpoints that mutate per-owner state.
 *
 * AUDIT #11. `/api/hedge/quote` took `owner` as a plain body field with no
 * proof of control, and `issueQuote` refuses a second open quote for a
 * position mint regardless of WHO asked. Position mints are public
 * on-chain, so anyone could quote a victim's position and lock them out of
 * their own for the 120s quote TTL, renewing on lapse to deny them
 * indefinitely — while consuming the VICTIM's per-owner budget, since the
 * quote is attributed to the position's owner. The `maxLifetimeQuotes`
 * ceiling made it worse: 50,000 quotes bricks the product for everyone
 * with no compaction tooling to recover.
 *
 * The fix is a challenge–response: the server mints a single-use nonce,
 * the wallet signs a canonical message naming the owner, the position and
 * that nonce, and the server verifies the ed25519 signature against the
 * claimed owner's public key.
 *
 * Verification uses Node's native ed25519 (no new dependency): a raw
 * 32-byte Solana public key becomes an SPKI key by prefixing the fixed
 * DER header below.
 *
 * Nonces live in memory. The deployment is single-replica by design (see
 * deploy/README.md), the same assumption the rate limiter already makes.
 */

import { createPublicKey, randomBytes, verify as edVerify } from "crypto";
import { PublicKey } from "@solana/web3.js";

/** DER SPKI header for an Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const NONCE_TTL_MS = 120_000;
const MAX_NONCES = 10_000;

interface Nonce {
  owner: string;
  expiresAt: number;
}

const KEY = Symbol.for("lh.wallet-auth.nonces");
type G = typeof globalThis & { [KEY]?: Map<string, Nonce> };

function nonces(): Map<string, Nonce> {
  const g = globalThis as G;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

/** Mint a single-use challenge bound to one owner. */
export function issueChallenge(owner: string): { nonce: string; expiresAtTs: number } {
  const map = nonces();
  const now = Date.now();

  // Opportunistic sweep, plus a hard cap so a flood cannot grow the map
  // without bound (the endpoint is rate limited, this is defence in depth).
  if (map.size > MAX_NONCES) {
    for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
    if (map.size > MAX_NONCES) map.clear();
  }

  const nonce = randomBytes(24).toString("base64url");
  map.set(nonce, { owner, expiresAt: now + NONCE_TTL_MS });
  return { nonce, expiresAtTs: Math.floor((now + NONCE_TTL_MS) / 1000) };
}

/**
 * The exact bytes a wallet must sign. Human-readable on purpose: a signing
 * prompt should say what it authorises, and it names the position so a
 * signature for one cannot be replayed against another.
 */
export function challengeMessage(params: {
  owner: string;
  positionMint: string;
  nonce: string;
}): string {
  return [
    "Liquidity Hedge — authorise a quote",
    "",
    `Owner: ${params.owner}`,
    `Position: ${params.positionMint}`,
    `Nonce: ${params.nonce}`,
    "",
    "Signing costs nothing and moves no funds.",
  ].join("\n");
}

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: string; status: 400 | 401 };

/**
 * Verify a wallet signature over the canonical message and BURN the nonce.
 *
 * The nonce is consumed on every outcome, success or failure, so a
 * captured challenge can never be reused for a second attempt.
 */
export function verifyWalletProof(params: {
  owner: string;
  positionMint: string;
  nonce: unknown;
  signature: unknown;
}): AuthResult {
  if (typeof params.nonce !== "string" || params.nonce.length === 0) {
    return { ok: false, reason: "Missing `nonce` — request a challenge first.", status: 400 };
  }
  if (typeof params.signature !== "string" || params.signature.length === 0) {
    return { ok: false, reason: "Missing `signature`.", status: 400 };
  }

  const map = nonces();
  const entry = map.get(params.nonce);
  map.delete(params.nonce); // single use, whatever happens next

  if (!entry) {
    return { ok: false, reason: "Unknown or already-used nonce.", status: 401 };
  }
  if (Date.now() > entry.expiresAt) {
    return { ok: false, reason: "Challenge expired — request a new one.", status: 401 };
  }
  if (entry.owner !== params.owner) {
    return { ok: false, reason: "Challenge was issued for a different owner.", status: 401 };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(params.signature, "base64");
  } catch {
    return { ok: false, reason: "Signature is not valid base64.", status: 400 };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: "Signature must be 64 bytes.", status: 400 };
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(new PublicKey(params.owner).toBytes());
  } catch {
    return { ok: false, reason: "Invalid owner public key.", status: 400 };
  }

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(
      challengeMessage({
        owner: params.owner,
        positionMint: params.positionMint,
        nonce: params.nonce,
      }),
      "utf8",
    );
    // `null` algorithm: Ed25519 signs the message directly, no pre-hash.
    if (!edVerify(null, message, key, signature)) {
      return { ok: false, reason: "Signature does not match the owner.", status: 401 };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "Signature verification failed.", status: 401 };
  }
}
