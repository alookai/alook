import { describe, expect, it, vi } from "vitest";
import { SITE_OG_IMAGE, SITE_OG_IMAGE_URL } from "@/lib/seo/site-metadata";

vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }));
vi.mock("@blog/lib/blog/posts", () => ({ getAllPosts: vi.fn() }));
vi.mock("@blog/app/blog/(index)/recent-posts", () => ({ RecentPosts: () => null }));

import { metadata as blog } from "@blog/app/blog/(index)/page";
import { metadata as guides } from "@blog/app/guides/page";
import { metadata as tutorials } from "@blog/app/tutorials/page";

const pages = [
  ["blog", blog, "https://alook.ai/blog", "Blog — AI Agent Collaboration & Workflows — Alook"],
  ["tutorials", tutorials, "https://alook.ai/tutorials", "Tutorials — Alook"],
  ["guides", guides, "https://alook.ai/guides", "Guides — Coding Agent Collaboration — Alook"],
] as const;

describe("Blog public page metadata", () => {
  it.each(pages)("keeps %s search and sharing metadata aligned", (_name, metadata, url, title) => {
    expect(metadata.title).toEqual({ absolute: title });
    expect(metadata.description).toEqual(expect.any(String));
    expect(metadata.description!.length).toBeGreaterThan(50);
    expect(metadata.alternates?.canonical).toBe(url);
    expect(metadata.openGraph).toEqual({
      type: "website",
      siteName: "Alook",
      title,
      description: metadata.description,
      url,
      images: [SITE_OG_IMAGE],
    });
    expect(metadata.twitter).toEqual({
      card: "summary_large_image",
      site: "@alook_ai",
      title,
      description: metadata.description,
      images: [SITE_OG_IMAGE_URL],
    });
  });


  it("preserves Blog discovery links", () => {
    expect(blog.alternates?.types).toEqual({
      "application/rss+xml": "/blog/feed.xml",
      "text/markdown": "/llms.txt",
    });
  });
});
