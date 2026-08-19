import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { BlogPost } from "./types";
import { isDraftBlogPost, readBlogMetadata } from "./validate-assets";
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
  it("matches the real published post set in both directions", () => {
    const registrySlugs = blogTopics
      .flatMap((topic) => topic.entries.map((entry) => entry.slug))
      .sort();
    const contentDir = join(process.cwd(), "src", "content");
    const publishedSlugs = readdirSync(contentDir)
      .filter((file) => file.endsWith(".mdx"))
      .flatMap((file) => {
        const fileSlug = file.replace(/\.mdx$/, "");
        const content = readFileSync(join(contentDir, file), "utf-8");
        if (isDraftBlogPost(content)) return [];

        const { metadata, errors } = readBlogMetadata(content, fileSlug);
        expect(errors).toEqual([]);
        return metadata.slug ? [metadata.slug] : [];
      })
      .sort();

    expect(registrySlugs).toEqual(publishedSlugs);
  });

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

  it("preserves the exact locked user job for every slug", () => {
    expect(
      Object.fromEntries(
        blogTopics.flatMap((topic) =>
          topic.entries.map((entry) => [entry.slug, entry.userJob])
        )
      )
    ).toEqual({
      "ai-agent-vs-chatbot": "Decide whether I need an agent or a chatbot",
      "how-to-delegate-tasks-to-ai-agents":
        "Package a task so an agent can run it reliably",
      "ai-agent-team": "Design a multi-agent team with roles and handoffs",
      "ai-agent-orchestration":
        "Understand the coordination layer between agents",
      "multi-agent-workflow-patterns":
        "Pick a workflow pattern for my multi-agent setup",
      "run-ai-agent-team-that-stays-on-track":
        "Keep a running agent team from drifting",
      "ai-team-vs-ai-tools":
        "Stop being the copy-paste layer between coding agents",
      "claude-code-subagents-vs-independent-agents":
        "Choose nested vs independent agents for my Claude Code work",
      "claude-code-and-codex-same-team":
        "Use Claude Code and Codex together as one coordinated team",
      "claude-code-dynamic-workflow-alternative":
        "Choose between session workflows and persistent coordination",
      "keep-context-across-coding-agent-sessions":
        "Carry decisions across coding agent sessions",
      "multiple-ai-agents-edit-same-repository":
        "Run parallel agents on one repo without conflicts",
      "prevent-coding-agents-duplicating-work":
        "Stop agents from redoing each other's work",
      "shared-context-between-agents":
        "Understand why agents drift without shared context",
      "what-makes-a-shared-ai-workspace-usable":
        "Judge whether a shared workspace actually works",
      "human-ai-collaboration-small-teams":
        "Move from one chat to a coordinated human+agent team",
      "humans-and-ai-agents-in-one-room":
        "Bring multiple people's agents into one shared room",
      "why-we-built-alook": "Understand why Alook exists (founder narrative)",
      "ai-agent-identity":
        "Evaluate whether an agent stays addressable across rooms and servers",
      "personal-ai-company": "Run a one-person company with AI agents",
      "multi-agent-collaboration-without-code":
        "Coordinate multiple agents without writing orchestration code",
      "no-code-automation-ai-agents":
        "Choose between trigger-action automation and agent teams",
    });
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
