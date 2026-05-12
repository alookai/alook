import type { MetadataRoute } from "next";
import { TEMPLATES } from "@/lib/templates";

const SITE_URL = "https://alook.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  const templateEntries: MetadataRoute.Sitemap = TEMPLATES.map((t) => ({
    url: `${SITE_URL}/templates/${t.id}`,
    lastModified: new Date(),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/templates`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...templateEntries,
    {
      url: `${SITE_URL}/sign-in`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
