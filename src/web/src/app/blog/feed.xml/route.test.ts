import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog/posts", () => ({
  getAllPosts: vi.fn(),
}));

import { getAllPosts } from "@/lib/blog/posts";
import { dynamic, GET } from "./route";

describe("GET /blog/feed.xml", () => {
  beforeEach(() => {
    vi.mocked(getAllPosts).mockReset();
  });

  it("is prerendered for Cloudflare Workers", () => {
    expect(dynamic).toBe("force-static");
  });

  it("returns RSS with blog posts and correct content type", async () => {
    vi.mocked(getAllPosts).mockResolvedValue([
      {
        slug: "why-we-built-alook",
        title: "Why We Built Alook",
        date: "2026-05-15",
        author: "Gus",
        excerpt: "Origin story excerpt.",
        readingTime: "5 min read",
      },
    ]);

    const res = await GET();
    const body = await res.text();

    expect(res.headers.get("Content-Type")).toBe("application/rss+xml");
    expect(body).toContain("<title>Alook Blog</title>");
    expect(body).toContain("https://alook.ai/blog/why-we-built-alook");
    expect(body).toContain("Why We Built Alook");
  });
});
