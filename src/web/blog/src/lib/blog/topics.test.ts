import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import type { BlogPost } from "./types";
import { isDraftBlogPost, readBlogMetadata } from "./validate-assets";
import {
  blogTopics,
  getBlogTopicBySlug,
  getNextTopicBridge,
  getPostsForTopic,
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
    const contentDir = fileURLToPath(new URL("../../content", import.meta.url));
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

  it("covers all 36 published slugs exactly once", () => {
    const orderedSlugs = blogTopics.map((topic) =>
      topic.entries.map((entry) => entry.slug)
    );
    const slugs = orderedSlugs.flat();

    expect(slugs).toHaveLength(36);
    expect(new Set(slugs).size).toBe(36);
    expect(orderedSlugs).toEqual([
      [
        "ai-agent-vs-chatbot",
        "grok-bot-vs-meta-muse-vs-manus-cue",
        "personal-agents-vs-coding-agents",
        "local-ai-agents",
        "how-to-delegate-tasks-to-ai-agents",

        "ai-agent-orchestration",
        "ai-agent-collaboration-platforms",
        "multi-agent-workflow-patterns",
        "run-ai-agent-team-that-stays-on-track",
        "paperclip-alternatives",
      ],
      [
        "claude-agent-teams",
        "vercel-board",
        "opencode-vs-claude-code",
        "cursor-vs-claude-code",
        "claude-code-vs-codex",
        "claude-code-codex-cursor-grok-which-to-choose",
        "claude-code-subagents-vs-independent-agents",
        "claude-code-and-codex-same-team",
        "claude-code-dynamic-workflow-alternative",
        "keep-context-across-coding-agent-sessions",
        "codex-memory",
        "claude-code-memory",
        "share-claude-code-session",
        "multiple-ai-agents-edit-same-repository",
        "prevent-coding-agents-duplicating-work",
      ],
      [
        "ai-agent-communication",
        "introducing-alook",
        "human-agent-collaboration",
        "shared-context-between-agents",
        "alook-vs-buzz",
        "alook-vs-grok-bot",
        "ask-coworker-codex-claude-code",
        "why-we-built-alook",
        "ai-agent-identity",
        "how-to-build-liquid-software",
      ],
      [
        "personal-ai-company",
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
      "claude-agent-teams": "Find stalled Claude teammates and review a team’s work",
      "vercel-board": "Understand how teams use Vercel Board for agent tasks and conversations",
      "claude-code-vs-codex": "Choose Claude Code or Codex by patch review, permissions, runtime and plan usage",
      "opencode-vs-claude-code": "Choose OpenCode or Claude Code by model choice, cost, memory and migration needs",
      "cursor-vs-claude-code": "Choose Cursor or Claude Code by editing workflow, models, pricing and first-project needs",
      "codex-memory": "Recover a Codex task after compaction and distinguish task context, project rules and local Memories",
      "claude-code-codex-cursor-grok-which-to-choose": "Choose a coding or personal-agent harness for a concrete task using reported strengths and weaknesses",
      "ask-coworker-codex-claude-code": "Let coworkers talk to the coding agents that did the work",
      "ai-agent-vs-chatbot": "Decide whether I need an agent or a chatbot",
      "personal-agents-vs-coding-agents": "Decide whether my existing coding tools cover the work or I need another agent product",
      "grok-bot-vs-meta-muse-vs-manus-cue": "Choose a personal-agent product by tools, ongoing work and review controls",
      "local-ai-agents":
        "Choose which parts of an AI agent should run locally",
      "how-to-delegate-tasks-to-ai-agents":
        "Package a task so an agent can run it reliably",
      "ai-agent-orchestration":
        "Understand the coordination layer between agents",
      "ai-agent-collaboration-platforms":
        "Choose an agent collaboration platform by application, workflow, and workspace needs",
      "multi-agent-workflow-patterns":
        "Pick a workflow pattern for my multi-agent setup",
      "run-ai-agent-team-that-stays-on-track":
        "Keep a running agent team from drifting",
      "paperclip-alternatives":
        "Choose a Paperclip alternative for direct agent work, coding review, reusable research, or shared team conversations",
      "claude-code-subagents-vs-independent-agents":
        "Choose nested vs independent agents for my Claude Code work",
      "claude-code-and-codex-same-team":
        "Use Claude Code and Codex together as one coordinated team",
      "claude-code-dynamic-workflow-alternative":
        "Choose between session workflows and persistent coordination",
      "keep-context-across-coding-agent-sessions":
        "Carry decisions across coding agent sessions",
      "claude-code-memory":
        "Verify Claude Code memory across fresh sessions and fix stale notes",
      "share-claude-code-session":
        "Share a Claude Code session or transcript so a teammate can review or continue the work",
      "multiple-ai-agents-edit-same-repository":
        "Run parallel agents on one repo without conflicts",
      "prevent-coding-agents-duplicating-work":
        "Stop agents from redoing each other's work",
      "ai-agent-communication":
        "Choose the right communication layer for agents, protocols, and teams",
      "introducing-alook":
        "See how people and AI agents talk directly in shared rooms",
      "human-agent-collaboration":
        "Keep questions, evidence and decisions connected when teammates bring their own agents",
      "shared-context-between-agents":
        "Understand why agents drift without shared context",
      "alook-vs-buzz":
        "Choose between Alook and Buzz by Block for shared agent work",
      "alook-vs-grok-bot":
        "Choose an open-source Grok Bot alternative while keeping my team’s existing agents and projects",
      "why-we-built-alook": "Understand why Alook exists (founder narrative)",
      "ai-agent-identity":
        "Evaluate whether an agent stays addressable across rooms and servers",
      "how-to-build-liquid-software":
        "Turn user feedback into code changes by putting my coding agent in my user community",
      "personal-ai-company": "Run a one-person company with AI agents",
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
    const topic = blogTopics[0];
    const available = allPosts.filter(
      (candidate) => candidate.slug !== "ai-agent-orchestration"
    );

    expect(getPostsForTopic(topic, available).map((candidate) => candidate.slug)).toEqual([
      "ai-agent-vs-chatbot",
      "grok-bot-vs-meta-muse-vs-manus-cue",
      "personal-agents-vs-coding-agents",
      "local-ai-agents",
      "how-to-delegate-tasks-to-ai-agents",
      "ai-agent-collaboration-platforms",
      "multi-agent-workflow-patterns",
      "run-ai-agent-team-that-stays-on-track",
      "paperclip-alternatives",
    ]);
  });

  it("bridges to the next topic pillar and wraps to the first topic", () => {
    expect(getNextTopicBridge("ai-agent-orchestration", allPosts)?.post.slug).toBe(
      "claude-code-and-codex-same-team"
    );
    expect(getNextTopicBridge("personal-ai-company", allPosts)?.post.slug).toBe(
      "ai-agent-orchestration"
    );
  });
});
