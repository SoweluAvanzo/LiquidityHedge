/**
 * Per-request nonce-based Content-Security-Policy (NFR-SEC5).
 *
 * script-src is the load-bearing directive: 'nonce-…' + 'strict-dynamic'
 * means NO script executes unless it carries this request's nonce (Next
 * injects it into framework/page scripts during SSR) or is loaded by such
 * a script. Injected inline <script> from XSS is dead on arrival.
 *
 * Accepted residual (documented, deliberate): style-src 'unsafe-inline'.
 * The dashboard's charts and the wallet modal use React inline style
 * attributes, which nonces cannot cover (nonce applies to elements, not
 * attributes). CSS injection without script execution is a far weaker
 * vector; revisit if we ever render untrusted content.
 *
 * connect-src allows same-origin APIs plus the browser-side Solana RPC
 * (http + websocket forms), derived from NEXT_PUBLIC_RPC_URL.
 *
 * Requires dynamic rendering on every page (layout.tsx forces it) — a
 * statically prerendered page would ship nonce-less scripts that this
 * policy would then block.
 */

import { NextRequest, NextResponse } from "next/server";

function rpcOrigins(): string {
  const url = process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";
  try {
    const u = new URL(url);
    return `https://${u.host} wss://${u.host}`;
  } catch {
    return "https://api.mainnet-beta.solana.com wss://api.mainnet-beta.solana.com";
  }
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  // upgrade-insecure-requests only behind TLS (Caddy sets the forwarded
  // proto) — on the plain-HTTP local smoke stack it would break assets.
  const isHttps =
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `connect-src 'self' ${rpcOrigins()}${isDev ? " ws: wss:" : ""}`,
    ...(isHttps ? [`upgrade-insecure-requests`] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // All routes except API responses (JSON — CSP is a document policy)
    // and static assets.
    //
    // AUDIT #16: prefetch requests were excluded here, but Next still
    // serves a COMPLETE HTML document for them — so those documents went
    // out with no Content-Security-Policy header at all (verified: normal
    // request 1 CSP header, `purpose: prefetch` request 0). A document
    // shipped without its security policy is a gap whether or not a
    // reuse path is currently demonstrable, so prefetches get the policy
    // too.
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};
