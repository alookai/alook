import { createElement } from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { BlogPost } from "@blog/lib/blog/posts";
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

  it("renders published and updated dates as semantic time elements", () => {
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(createElement(BlogPostByline, { post }));
    });

    const times = renderer!.root.findAllByType("time");
    expect(times.map((time) => time.props.dateTime)).toEqual([
      "2026-08-20",
      "2026-09-01",
    ]);
    expect(times.map((time) => time.children.join(""))).toEqual([
      "August 20, 2026",
      "Updated September 1, 2026",
    ]);
  });
});
