import { describe, expect, it } from "vitest";
import type { BlogPost } from "./types";
import { buildBlogPostingJsonLd } from "./json-ld";

const base: BlogPost = {
  slug: "sample",
  title: "Sample",
  date: "2026-06-08",
  author: "Alook Team",
  excerpt: "Excerpt",
  readingTime: "5 min read",
  image: "/blog/sample/hero.webp",
};

describe("buildBlogPostingJsonLd", () => {
  it("omits dateModified when not set", () => {
    const jsonLd = buildBlogPostingJsonLd(base);
    expect(jsonLd.datePublished).toBe("2026-06-08");
    expect(jsonLd).not.toHaveProperty("dateModified");
    expect(jsonLd.image).toBe("https://alook.ai/blog/sample/hero.webp");
  });

  it("includes dateModified when set", () => {
    const jsonLd = buildBlogPostingJsonLd({
      ...base,
      dateModified: "2026-07-23",
    });
    expect(jsonLd.datePublished).toBe("2026-06-08");
    expect(jsonLd.dateModified).toBe("2026-07-23");
  });
});
