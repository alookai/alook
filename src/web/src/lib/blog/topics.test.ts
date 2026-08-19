import { describe, expect, it } from "vitest";
import type { BlogPost } from "./types";
import {
  blogTopics,
  getBlogTopicBySlug,
  getNextTopicBridge,
  getPostsForTopic,
  getRelatedPosts,
} from "./topics";

const post = (slug: string): BlogPost => ({
  slug,
  title: slug,
  date: "2026-08-01",
  author: "Alook Team",
  excerpt: `${slug} excerpt`,
  readingTime: "5 min read",
});

const allPosts = blogTopics.flatMap((topic) =>
  topic.entries.map((entry) => post(entry.slug))
);

describe("blogTopics", () => {
  it("covers all 22 locked slugs exactly once", () => {
    const orderedSlugs = blogTopics.map((topic) =>
      topic.entries.map((entry) => entry.slug)
    );
    const slugs = orderedSlugs.flat();

    expect(slugs).toHaveLength(22);
    expect(new Set(slugs).size).toBe(22);
    expect(orderedSlugs).toEqual([
      [
        "ai-agent-vs-chatbot",
        "how-to-delegate-tasks-to-ai-agents",
        "ai-agent-team",
        "ai-agent-orchestration",
        "multi-agent-workflow-patterns",
        "run-ai-agent-team-that-stays-on-track",
      ],
      [
        "ai-team-vs-ai-tools",
        "claude-code-subagents-vs-independent-agents",
        "claude-code-and-codex-same-team",
        "claude-code-dynamic-workflow-alternative",
        "keep-context-across-coding-agent-sessions",
        "multiple-ai-agents-edit-same-repository",
        "prevent-coding-agents-duplicating-work",
      ],
      [
        "shared-context-between-agents",
        "what-makes-a-shared-ai-workspace-usable",
        "human-ai-collaboration-small-teams",
        "humans-and-ai-agents-in-one-room",
        "why-we-built-alook",
        "ai-agent-identity",
      ],
      [
        "personal-ai-company",
        "multi-agent-collaboration-without-code",
        "no-code-automation-ai-agents",
      ],
    ]);
  });

  it("keeps every pillar inside its own topic", () => {
    for (const topic of blogTopics) {
      expect(topic.entries.map((entry) => entry.slug)).toContain(
        topic.pillarSlug
      );
    }
  });

  it("resolves a topic from any mapped slug", () => {
    expect(getBlogTopicBySlug("ai-agent-identity")?.id).toBe(
      "shared-human-agent-workspace"
    );
    expect(getBlogTopicBySlug("not-a-post")).toBeUndefined();
  });
});

describe("topic discovery", () => {
  it("returns posts in the locked topic order and filters missing posts", () => {
    const topic = blogTopics[3];
    const available = allPosts.filter(
      (candidate) => candidate.slug !== "multi-agent-collaboration-without-code"
    );

    expect(getPostsForTopic(topic, available).map((candidate) => candidate.slug)).toEqual([
      "personal-ai-company",
      "no-code-automation-ai-agents",
    ]);
  });

  it("recommends support articles in order from a pillar", () => {
    expect(
      getRelatedPosts("ai-agent-team", allPosts).map(
        (candidate) => candidate.slug
      )
    ).toEqual([
      "ai-agent-vs-chatbot",
      "how-to-delegate-tasks-to-ai-agents",
      "ai-agent-orchestration",
    ]);
  });

  it("prioritizes the pillar, then nearby support articles", () => {
    expect(
      getRelatedPosts("ai-agent-orchestration", allPosts).map(
        (candidate) => candidate.slug
      )
    ).toEqual([
      "ai-agent-team",
      "multi-agent-workflow-patterns",
      "how-to-delegate-tasks-to-ai-agents",
    ]);
  });

  it("never returns the current article or missing metadata", () => {
    const available = allPosts.filter(
      (candidate) => candidate.slug !== "ai-agent-team"
    );
    const related = getRelatedPosts("ai-agent-vs-chatbot", available);

    expect(related.map((candidate) => candidate.slug)).not.toContain(
      "ai-agent-vs-chatbot"
    );
    expect(related.map((candidate) => candidate.slug)).not.toContain(
      "ai-agent-team"
    );
  });

  it("bridges to the next topic pillar and wraps to the first topic", () => {
    expect(getNextTopicBridge("ai-agent-team", allPosts)?.post.slug).toBe(
      "claude-code-and-codex-same-team"
    );
    expect(getNextTopicBridge("personal-ai-company", allPosts)?.post.slug).toBe(
      "ai-agent-team"
    );
  });
});
