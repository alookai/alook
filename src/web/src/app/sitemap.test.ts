import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog/posts", () => ({
  getAllPosts: vi.fn(),
}));

import { getAllPosts } from "@/lib/blog/posts";
import sitemap from "./sitemap";

const posts = [
  {
    slug: "revised",
    title: "Revised",
    date: "2026-06-08",
    dateModified: "2026-07-23",
    author: "Alook Team",
    excerpt: "Revised excerpt.",
    readingTime: "5 min read",
  },
  {
    slug: "published",
    title: "Published",
    date: "2026-07-01",
    author: "Gus",
    excerpt: "Published excerpt.",
    readingTime: "4 min read",
  },
];

describe("sitemap", () => {
  beforeEach(() => {
    vi.mocked(getAllPosts).mockReset();
    vi.mocked(getAllPosts).mockResolvedValue(posts);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists only indexable public routes", async () => {
    const entries = await sitemap();
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
    const first = await sitemap();
    vi.setSystemTime("2027-01-01T00:00:00Z");
    const second = await sitemap();

    expect(second).toEqual(first);
    expect(first.find((entry) => entry.url.endsWith("/blog/revised")))
      .toHaveProperty("lastModified", "2026-07-23");
    expect(first.find((entry) => entry.url.endsWith("/blog/published")))
      .toHaveProperty("lastModified", "2026-07-01");
    expect(first.find((entry) => entry.url === "https://alook.ai/blog"))
      .toHaveProperty("lastModified", "2026-07-23");
  });

  it("omits unverifiable modification dates from static and template routes", async () => {
    const entries = await sitemap();
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
});
