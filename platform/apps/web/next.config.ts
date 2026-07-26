import type { NextConfig } from "next";

/**
 * Security baseline headers applied to all routes.
 *
 * NOTE (NFR-SEC5): a nonce-based Content-Security-Policy is a pre-launch
 * requirement and is intentionally NOT included here. We deliberately do not
 * fake a CSP with `unsafe-inline` / `unsafe-eval` allowances, as that would
 * provide a false sense of security. The nonce-based CSP must be implemented
 * via middleware (per-request nonce) before launch.
 */
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the hardened Docker image
  // (platform/apps/web/Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  // Workspace packages ship raw TypeScript (main: src/index.ts) — compile
  // them as part of the app bundle.
  transpilePackages: [
    "@lh/core",
    "@lh/hedge",
    "@lh/market-data",
    "@lh/ops-jobs",
    "@lh/portfolio",
    "@lh/risk-models",
  ],
  // Image optimization disabled: no remote images and the `sharp` native
  // build script is declined in the workspace (supply-chain posture).
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
