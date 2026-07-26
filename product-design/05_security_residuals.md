# Dependency-advisory residuals (NFR-SEC4)

Reviewed 2026-07-26. CI reports every advisory (non-blocking) and fails only
on **critical** advisories in production dependencies. Each residual HIGH
below is either unfixable upstream or not reachable at runtime.

| Advisory | Path | Status | Mitigation / rationale |
|---|---|---|---|
| Next.js — Middleware/Proxy bypass in App Router | `apps/web > next` | **FIXED 2026-07-26** | Upgraded 16.2.10 → **16.2.11**. Directly relevant: the nonce CSP is implemented in `proxy.ts`, so a proxy bypass would have weakened it. |
| `bigint-buffer` — buffer overflow | `packages/core > @solana/spl-token > @solana/buffer-layout-utils` | Residual, **no upstream fix** | 1.1.5 is the latest published version; `>=1.1.6` does not exist. Native build scripts are **declined** in the workspace (`allowBuilds: bigint-buffer: false`), so the vulnerable native addon is never compiled — the pure-JS fallback runs (visible as the "bigint: Failed to load bindings" notice). Revisit when upstream publishes a fix. |
| `postcss` — arbitrary file read / path traversal | `apps/web > next > postcss` | Partly pinned | `pnpm.overrides` pins `postcss >= 8.5.18`; residual paths come from Next's own pinned range. Build-time only (CSS pipeline), not a runtime request path. |
| `sharp` / libvips CVEs | `apps/web > next > sharp` | Residual, not exercised | Build scripts declined and `images.unoptimized: true` — no image optimization runs, so libvips is never invoked. Removed entirely if Next drops the optional dep. |

## Review policy

- The non-blocking audit report is read at every release gate; any advisory
  that becomes fixable is fixed in that release.
- A new **critical** advisory fails CI immediately.
- Advisories in dev-only tooling (eslint → minimatch → brace-expansion,
  serialize-javascript, uuid in test tooling) are out of the production
  surface and tracked only in the report.
