import type { MetadataRoute } from "next";
import { TEMPLATES } from "@/lib/templates";
import { getAllPosts } from "@/lib/blog/posts";

const SITE_URL = "https://alook.ai";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const templateEntries: MetadataRoute.Sitemap = TEMPLATES.map((t) => ({
    url: `${SITE_URL}/templates/${t.id}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const posts = await getAllPosts();
  const blogEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${SITE_URL}/blog/${post.slug}`,
    lastModified: post.dateModified ?? post.date,
    changeFrequency: "monthly",
    priority: 0.6,
  }));
  const latestBlogModification = posts.reduce<string | undefined>(
    (latest, post) => {
      const modified = post.dateModified ?? post.date;
      return !latest || modified > latest ? modified : latest;
    },
    undefined
  );

  return [
    {
      url: SITE_URL,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/templates`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...templateEntries,
    {
      url: `${SITE_URL}/blog`,
      ...(latestBlogModification
        ? { lastModified: latestBlogModification }
        : {}),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...blogEntries,
    {
      url: `${SITE_URL}/privacy`,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
