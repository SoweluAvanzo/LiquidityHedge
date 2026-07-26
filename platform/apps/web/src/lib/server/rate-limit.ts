/**
 * A10 — shared rate limiting for expensive routes.
 *
 * Previously only /api/portfolio was limited, with a bucket keyed on the
 * FIRST X-Forwarded-For entry — which the client controls, so rotating the
 * header bypassed it entirely.
 *
 * Client identity is now taken from the LAST hop appended by our own
 * trusted proxy (or CF-Connecting-IP when Cloudflare fronts us), which a
 * client cannot forge. Buckets are per-process; the deployment is
 * single-replica by design (see deploy/README.md), and the edge should
 * carry the coarse limits — this is defence in depth, not the only line.
 */

import type { NextRequest } from "next/server";

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
}

/** Cost-tiered defaults: heavier work gets a tighter budget. */
export const LIMITS = {
  portfolio: { max: 20, windowMs: 60_000 }, //  RPC fan-out
  simulate: { max: 6, windowMs: 60_000 }, //    Monte-Carlo (CPU-bound)
  quote: { max: 10, windowMs: 60_000 }, //      RPC + pricing
  order: { max: 10, windowMs: 60_000 }, //      writes to the order ledger
  status: { max: 60, windowMs: 60_000 }, //     cheap polling
  download: { max: 5, windowMs: 60_000 }, //    streams the whole dataset
} as const satisfies Record<string, Limit>;

interface Bucket {
  count: number;
  resetAt: number;
}

const KEY = Symbol.for("lh.rate-limit");
type G = typeof globalThis & { [KEY]?: Map<string, Bucket> };

function buckets(): Map<string, Bucket> {
  const g = globalThis as G;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

/**
 * The client address, as far as it can be trusted.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot survive from a client
 * (Cloudflare overwrites it). Otherwise we take the LAST X-Forwarded-For
 * entry — appended by our own reverse proxy — never the first, which is
 * whatever the client sent.
 */
export function clientKey(req: NextRequest): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return `cf:${cf.trim()}`;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return `xff:${parts[parts.length - 1]}`;
  }
  const real = req.headers.get("x-real-ip");
  return real ? `real:${real.trim()}` : "unknown";
}

export interface LimitResult {
  ok: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export function checkLimit(req: NextRequest, name: keyof typeof LIMITS): LimitResult {
  const limit = LIMITS[name];
  const key = `${name}:${clientKey(req)}`;
  const now = Date.now();
  const map = buckets();

  // Opportunistic sweep so the map cannot grow without bound.
  if (map.size > 10_000) {
    for (const [k, b] of map) if (b.resetAt <= now) map.delete(k);
  }

  const bucket = map.get(key);
  if (!bucket || bucket.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { ok: true, retryAfterSeconds: 0, remaining: limit.max - 1 };
  }
  bucket.count++;
  if (bucket.count > limit.max) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { ok: true, retryAfterSeconds: 0, remaining: limit.max - bucket.count };
}

/** Standard 429 response with Retry-After. */
export function tooManyRequests(result: LimitResult): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please slow down." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfterSeconds),
      },
    },
  );
}
