import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BlogPost } from "@blog/lib/blog/posts";
import { render } from "@/test/react-dom-harness";
import { BlogPostByline, buildBlogPostMetadata } from "./article-meta";

vi.mock("./og-image", () => ({
  getBlogOgImage: () => "/blog/example/hero.webp",
}));

const post: BlogPost = {
  slug: "example",
  title: "Visible article title",
  seoTitle: "Search article title",
  date: "2026-08-20",
  dateModified: "2026-09-01",
  author: "Alook",
  excerpt: "Article excerpt",
  readingTime: "5 min read",
};

describe("article metadata", () => {
  it("preserves templated article titles and adds descriptive OG image alt", () => {
    const metadata = buildBlogPostMetadata(post);

    expect(metadata.title).toBe("Search article title");
    expect(metadata.openGraph).toMatchObject({
      type: "article",
      publishedTime: "2026-08-20",
      modifiedTime: "2026-09-01",
      images: [
        {
          url: "/blog/example/hero.webp",
          width: 1200,
          height: 630,
          alt: "Search article title",
        },
      ],
    });
  });

  it("omits revision metadata and copy when the post has not been revised", () => {
    const unmodifiedPost = { ...post };
    delete unmodifiedPost.dateModified;

    const metadata = buildBlogPostMetadata(unmodifiedPost);
    expect(metadata.openGraph).not.toHaveProperty("modifiedTime");

    const rendered = render(createElement(BlogPostByline, { post: unmodifiedPost }));
    const times = rendered.container.querySelectorAll("time");
    expect(times).toHaveLength(1);
    expect(times[0]).toHaveAttribute("datetime", "2026-08-20");
    expect(times[0]).toHaveTextContent("August 20, 2026");
    expect(rendered.container).not.toHaveTextContent("Updated");
  });

  it.each(["America/Los_Angeles", "Pacific/Honolulu"])(
    "renders semantic dates on the authored calendar day in %s",
    (timeZone) => {
      const previousTimeZone = process.env.TZ;
      process.env.TZ = timeZone;

      try {
        const rendered = render(createElement(BlogPostByline, { post }));
        const times = rendered.container.querySelectorAll("time");
        expect(Array.from(times, (time) => time.dateTime)).toEqual([
          "2026-08-20",
          "2026-09-01",
        ]);
        expect(Array.from(times, (time) => time.textContent)).toEqual([
          "August 20, 2026",
          "Updated September 1, 2026",
        ]);
      } finally {
        if (previousTimeZone === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previousTimeZone;
        }
      }
    },
  );
});
