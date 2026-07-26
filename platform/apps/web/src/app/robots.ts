import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/**
 * Route handler — not affected by the root layout's `force-dynamic`, and
 * intentionally left cacheable (it reads no request-time API).
 *
 * The dev-only hedge endpoints and the API surface are disallowed: they
 * return JSON, are rate-limited, and have nothing for a crawler.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
