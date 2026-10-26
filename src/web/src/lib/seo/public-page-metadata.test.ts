import { describe, expect, it, vi } from "vitest";
import { buildPublicPageMetadata } from "./public-page-metadata";
import { SITE_OG_IMAGE, SITE_OG_IMAGE_URL } from "./site-metadata";

vi.mock("@/components/home/landing-page", () => ({ LandingPage: () => null }));
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }));
vi.mock("@/app/pricing/pricing-client", () => ({ default: () => null }));
vi.mock("@blog/lib/blog/posts", () => ({ getAllPosts: vi.fn() }));
vi.mock("@blog/app/blog/(index)/recent-posts", () => ({ RecentPosts: () => null }));

import { metadata as home } from "@/app/(home)/page";
import { metadata as pricing } from "@/app/pricing/page";
import { metadata as blog } from "@blog/app/blog/(index)/page";
import { metadata as guides } from "@blog/app/guides/page";

const pages = [
  ["home", home, "https://alook.ai", "Alook | Multi-Agent Collaboration for Team and Friends"],
  ["pricing", pricing, "https://alook.ai/pricing", "Pricing — Free, Studio & House Plans — Alook"],
  ["blog", blog, "https://alook.ai/blog", "Blog — AI Agent Collaboration & Workflows — Alook"],
  ["guides", guides, "https://alook.ai/guides", "Guides — Coding Agent Collaboration — Alook"],
] as const;

describe("public page metadata", () => {
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

  it("preserves the approved homepage description and Blog discovery links", () => {
    expect(home.description).toBe(
      "Bring Claude Code and Codex agents into shared chats with Alook. Coordinate multi-agent workflows, share context, and review work with your team.",
    );
    expect(blog.alternates?.types).toEqual({
      "application/rss+xml": "/blog/feed.xml",
      "text/markdown": "/llms.txt",
    });
  });

  it("keeps nested public page canonical URLs under the site origin", () => {
    const metadata = buildPublicPageMetadata({
      title: "Example — Alook",
      description: "Example description",
      path: "/example/nested",
    });
    expect(metadata.alternates?.canonical).toBe("https://alook.ai/example/nested");
  });
});
