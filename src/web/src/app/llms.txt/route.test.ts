import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog/posts", () => ({
  getAllPosts: vi.fn(),
}));

import { getAllPosts } from "@/lib/blog/posts";
import { GET } from "./route";

describe("GET /llms.txt", () => {
  beforeEach(() => {
    vi.mocked(getAllPosts).mockReset();
  });

  it("returns markdown with blog posts and correct content type", async () => {
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

    expect(res.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(body).toContain("# Alook");
    expect(body).toContain(
      "[Why We Built Alook](https://alook.ai/blog/why-we-built-alook)"
    );
  });
});
