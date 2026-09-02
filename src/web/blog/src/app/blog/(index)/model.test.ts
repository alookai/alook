import { describe, expect, it } from "vitest";
import type { BlogPost } from "@blog/lib/blog/posts";
import { buildBlogIndexModel, formatBlogPostDate } from "./model";

function post(
  slug: string,
  date: string,
  image?: string,
): BlogPost {
  return {
    slug,
    title: slug,
    date,
    author: "Alook",
    excerpt: `${slug} excerpt`,
    readingTime: "5 min read",
    image,
  };
}

describe("buildBlogIndexModel", () => {
  it("selects the newest post as Featured and excludes it from ordered Recent", () => {
    const model = buildBlogIndexModel([
      post("personal-ai-company", "2026-08-01"),
      post("local-ai-agents", "2026-09-01"),
      post("ai-agent-vs-chatbot", "2026-08-20"),
    ]);

    expect(model.featured?.slug).toBe("local-ai-agents");
    expect(model.recent.map((item) => item.slug)).toEqual([
      "ai-agent-vs-chatbot",
      "personal-ai-company",
    ]);
    expect(model.recent).not.toContainEqual(
      expect.objectContaining({ slug: "local-ai-agents" }),
    );
  });

  it("preserves hero images and resolves missing ones through the canonical OG fallback", () => {
    const model = buildBlogIndexModel([
      post("ai-agent-vs-chatbot", "2026-08-20", "/blog/ai-agent-vs-chatbot/hero.webp"),
      post("local-ai-agents", "2026-09-01"),
    ]);

    expect(model.featured?.imageUrl).toBe("/og/blog/local-ai-agents");
    expect(model.recent[0]?.imageUrl).toBe(
      "/blog/ai-agent-vs-chatbot/hero.webp",
    );
    expect(model.featured?.topicId).toBe("foundations-team-design");
  });

  it.each(["America/Los_Angeles", "Pacific/Honolulu"])(
    "keeps date-only metadata on the authored calendar day in %s",
    (timeZone) => {
      const previousTimeZone = process.env.TZ;
      process.env.TZ = timeZone;

      try {
        expect(formatBlogPostDate("2026-09-01")).toBe("Sep 1, 2026");
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
