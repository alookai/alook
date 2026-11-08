import { describe, expect, it } from "vitest";
import type { BlogPost } from "@blog/lib/blog/posts";
import { buildBlogPostCards, formatBlogPostDate } from "@blog/lib/blog/post-cards"

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

describe("buildBlogPostCards", () => {
  it("selects the newest post as Featured and excludes it from ordered Recent", () => {
    const model = buildBlogPostCards([
      post("personal-ai-company", "2026-08-01"),
      post("local-ai-agents", "2026-09-01"),
      post("ai-agent-vs-chatbot", "2026-08-20"),
    ]);

    expect(model[0]?.slug).toBe("local-ai-agents");
    expect(model.slice(1).map((item) => item.slug)).toEqual([
      "ai-agent-vs-chatbot",
      "personal-ai-company",
    ]);
    expect(model.slice(1)).not.toContainEqual(
      expect.objectContaining({ slug: "local-ai-agents" }),
    );
  });

  it("preserves hero images and resolves missing ones through the canonical OG fallback", () => {
    const model = buildBlogPostCards([
      post("ai-agent-vs-chatbot", "2026-08-20", "/blog/ai-agent-vs-chatbot/hero.webp"),
      post("local-ai-agents", "2026-09-01"),
    ]);

    expect(model[0]?.imageUrl).toBe("/og/blog/local-ai-agents");
    expect(model[1]?.imageUrl).toBe(
      "/blog/ai-agent-vs-chatbot/hero.webp",
    );
    expect(model[0]?.topicId).toBe("foundations-team-design");
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
