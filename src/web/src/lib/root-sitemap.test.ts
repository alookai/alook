import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRootSitemap, serializeRootSitemap } from "./root-sitemap";
import type { BlogDiscoveryManifestV1 } from "./blog-discovery-manifest";

const manifest: BlogDiscoveryManifestV1 = { version: 1, posts: [
  {
    slug: "revised",
    title: "Revised",
    date: "2026-06-08",
    dateModified: "2026-07-23",
    author: "Alook Team",
    excerpt: "Revised excerpt.",
  },
  {
    slug: "published",
    title: "Published",
    date: "2026-07-01",
    author: "Gus",
    excerpt: "Published excerpt.",
  },
] };

describe("sitemap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists only indexable public routes", async () => {
    const entries = buildRootSitemap(manifest);
    const urls = entries.map((entry) => entry.url);

    expect(urls).toContain("https://alook.ai");
    expect(urls).toContain("https://alook.ai/templates");
    expect(urls).toContain("https://alook.ai/blog");
    expect(urls).toContain("https://alook.ai/privacy");
    expect(urls).toContain("https://alook.ai/blog/revised");
    expect(urls).not.toContain("https://alook.ai/sign-in");
    expect(urls).not.toContain("https://alook.ai/llms.txt");
  });

  it("uses content metadata for stable blog modification dates", async () => {
    vi.setSystemTime("2026-08-19T00:00:00Z");
    const first = buildRootSitemap(manifest);
    vi.setSystemTime("2027-01-01T00:00:00Z");
    const second = buildRootSitemap(manifest);

    expect(second).toEqual(first);
    expect(first.find((entry) => entry.url.endsWith("/blog/revised")))
      .toHaveProperty("lastModified", "2026-07-23");
    expect(first.find((entry) => entry.url.endsWith("/blog/published")))
      .toHaveProperty("lastModified", "2026-07-01");
    expect(first.find((entry) => entry.url === "https://alook.ai/blog"))
      .toHaveProperty("lastModified", "2026-07-23");
  });

  it("omits unverifiable modification dates from static and template routes", async () => {
    const entries = buildRootSitemap(manifest);
    const datedUrls = new Set([
      "https://alook.ai/blog",
      "https://alook.ai/blog/revised",
      "https://alook.ai/blog/published",
    ]);

    for (const entry of entries) {
      if (!datedUrls.has(entry.url)) {
        expect(entry).not.toHaveProperty("lastModified");
      }
    }
  });

  it("serializes stable XML in route order", () => {
    const xml = serializeRootSitemap(buildRootSitemap(manifest));

    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.indexOf("https://alook.ai/templates")).toBeLessThan(xml.indexOf("https://alook.ai/blog"));
    expect(xml).toContain("<lastmod>2026-07-23</lastmod>");
  });

  it("omits Blog URLs for the explicit self-host mode", () => {
    const urls = buildRootSitemap(null).map((entry) => entry.url);

    expect(urls).not.toContain("https://alook.ai/blog");
    expect(urls).toContain("https://alook.ai/privacy");
  });
});
