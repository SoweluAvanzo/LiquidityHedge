import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/** Three pages: the landing page, the dashboard and the data checkout. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/app`,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/data`,
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ];
}
