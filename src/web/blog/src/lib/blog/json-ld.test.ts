import { describe, expect, it } from "vitest";
import type { BlogPost } from "./types";
import { buildBlogPostingJsonLd } from "./json-ld";
import { ALOOK_ORGANIZATION_ID } from "@/lib/seo/entities";

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
  it("uses the article image and canonical URL when a hero exists", () => {
    const jsonLd = buildBlogPostingJsonLd(
      base,
      "/blog/sample/hero.webp",
    );
    expect(jsonLd.datePublished).toBe("2026-06-08");
    expect(jsonLd).not.toHaveProperty("dateModified");
    expect(jsonLd.image).toBe("https://alook.ai/blog/sample/hero.webp");
    expect(jsonLd.mainEntityOfPage).toEqual({
      "@type": "WebPage",
      "@id": "https://alook.ai/blog/sample",
    });
    expect(jsonLd.url).toBe("https://alook.ai/blog/sample");
  });

  it("uses the absolute route-owned OG fallback when no hero exists", () => {
    const jsonLd = buildBlogPostingJsonLd(
      { ...base, image: undefined },
      "/og/blog/sample",
    );

    expect(jsonLd.image).toBe("https://alook.ai/og/blog/sample");
  });

  it("includes dateModified when set", () => {
    const jsonLd = buildBlogPostingJsonLd(
      {
        ...base,
        dateModified: "2026-07-23",
      },
      base.image!,
    );
    expect(jsonLd.datePublished).toBe("2026-06-08");
    expect(jsonLd.dateModified).toBe("2026-07-23");
  });

  it("uses the Alook organization as author for Alook Team", () => {
    const jsonLd = buildBlogPostingJsonLd(base, base.image!);

    expect(jsonLd.author).toEqual({
      "@type": "Organization",
      name: "Alook Team",
      url: "https://alook.ai/blog",
    });
    expect(jsonLd.publisher).toMatchObject({
      "@type": "Organization",
      "@id": ALOOK_ORGANIZATION_ID,
    });
  });

  it("uses a Person author for a named writer", () => {
    const jsonLd = buildBlogPostingJsonLd(
      {
        ...base,
        author: "Gus",
      },
      base.image!,
    );

    expect(jsonLd.author).toEqual({
      "@type": "Person",
      name: "Gus",
    });
  });
});
