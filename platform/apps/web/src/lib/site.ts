/**
 * Public identity of the site — used by metadata, JSON-LD, robots.txt and
 * the sitemap. The origin is configurable because the deployment domain is
 * set at the edge (deploy/Caddyfile, SITE_DOMAIN); the fallback is the
 * project's own domain so nothing ever emits a `localhost` canonical.
 */

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://liquidityhedge.nortadesyco.xyz"
).replace(/\/$/, "");

export const SITE_NAME = "Liquidity Hedge";

export const LEGAL_ENTITY = "Blocksventures Ltd";
export const LEGAL_ENTITY_JURISDICTION = "British Virgin Islands";

export const CONTACT_EMAIL = "sowelu.avanzo@nortadesyco.xyz";

/** Date the forward fee-growth collection started (ISO, UTC). */
export const COVERAGE_START = "2026-07-26";

export function mailto(subject: string, body?: string): string {
  const params = new URLSearchParams({ subject });
  if (body) params.set("body", body);
  return `mailto:${CONTACT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
}
