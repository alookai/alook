import type { BlogPost } from "./types";

export type BlogTopicEntry = {
  slug: string;
  userJob: string;
};

export type BlogTopic = {
  id: string;
  label: string;
  description: string;
  pillarSlug: string;
  entries: readonly BlogTopicEntry[];
};

export const blogTopics = [
  {
    id: "foundations-team-design",
    label: "Foundations & team design",
    description:
      "Understand what agents are, then design the roles, handoffs, and operating patterns that keep a team on track.",
    pillarSlug: "ai-agent-team",
    entries: [
      { slug: "ai-agent-vs-chatbot", userJob: "Decide whether I need an agent or a chatbot" },
      { slug: "local-ai-agents", userJob: "Choose which parts of an AI agent should run locally" },
      { slug: "how-to-delegate-tasks-to-ai-agents", userJob: "Package a task so an agent can run it reliably" },
      { slug: "ai-agent-team", userJob: "Design a multi-agent team with roles and handoffs" },
      { slug: "ai-agent-orchestration", userJob: "Understand the coordination layer between agents" },
      { slug: "multi-agent-workflow-patterns", userJob: "Pick a workflow pattern for my multi-agent setup" },
      { slug: "run-ai-agent-team-that-stays-on-track", userJob: "Keep a running agent team from drifting" },
    ],
  },
  {
    id: "coding-agents",
    label: "Coding agents across runtimes & repos",
    description:
      "Coordinate coding agents across tools and repositories without duplicated work, lost decisions, or merge conflicts.",
    pillarSlug: "claude-code-and-codex-same-team",
    entries: [
      { slug: "ai-team-vs-ai-tools", userJob: "Stop being the copy-paste layer between coding agents" },
      {
        slug: "claude-code-subagents-vs-independent-agents",
        userJob: "Choose nested vs independent agents for my Claude Code work",
      },
      {
        slug: "claude-code-and-codex-same-team",
        userJob: "Use Claude Code and Codex together as one coordinated team",
      },
      {
        slug: "claude-code-dynamic-workflow-alternative",
        userJob: "Choose between session workflows and persistent coordination",
      },
      {
        slug: "keep-context-across-coding-agent-sessions",
        userJob: "Carry decisions across coding agent sessions",
      },
      {
        slug: "multiple-ai-agents-edit-same-repository",
        userJob: "Run parallel agents on one repo without conflicts",
      },
      {
        slug: "prevent-coding-agents-duplicating-work",
        userJob: "Stop agents from redoing each other's work",
      },
    ],
  },
  {
    id: "shared-human-agent-workspace",
    label: "Shared context & human-agent workspace",
    description:
      "Build a workspace where people and agents share context, remain addressable, and coordinate in the same rooms.",
    pillarSlug: "humans-and-ai-agents-in-one-room",
    entries: [
      {
        slug: "ai-agent-communication",
        userJob: "Choose the right communication layer for agents, protocols, and teams",
      },
      { slug: "shared-context-between-agents", userJob: "Understand why agents drift without shared context" },
      {
        slug: "what-makes-a-shared-ai-workspace-usable",
        userJob: "Judge whether a shared workspace actually works",
      },
      {
        slug: "human-ai-collaboration-small-teams",
        userJob: "Move from one chat to a coordinated human+agent team",
      },
      {
        slug: "humans-and-ai-agents-in-one-room",
        userJob: "Bring multiple people's agents into one shared room",
      },
      { slug: "why-we-built-alook", userJob: "Understand why Alook exists (founder narrative)" },
      {
        slug: "ai-agent-identity",
        userJob: "Evaluate whether an agent stays addressable across rooms and servers",
      },
    ],
  },
  {
    id: "solo-business-no-code",
    label: "Solo business & no-code operations",
    description:
      "Turn repeatable work into a coordinated agent operation without building a custom orchestration system.",
    pillarSlug: "personal-ai-company",
    entries: [
      { slug: "personal-ai-company", userJob: "Run a one-person company with AI agents" },
      {
        slug: "multi-agent-collaboration-without-code",
        userJob: "Coordinate multiple agents without writing orchestration code",
      },
      {
        slug: "no-code-automation-ai-agents",
        userJob: "Choose between trigger-action automation and agent teams",
      },
    ],
  },
] as const satisfies readonly BlogTopic[];

export function getBlogTopicBySlug(slug: string): BlogTopic | undefined {
  return blogTopics.find((topic) =>
    topic.entries.some((entry) => entry.slug === slug)
  );
}

export function getBlogTopicEntryBySlug(
  slug: string
): BlogTopicEntry | undefined {
  return getBlogTopicBySlug(slug)?.entries.find((entry) => entry.slug === slug);
}

export function getPostsForTopic(
  topic: BlogTopic,
  posts: readonly BlogPost[]
): BlogPost[] {
  const postsBySlug = new Map(posts.map((post) => [post.slug, post]));
  return topic.entries.flatMap((entry) => {
    const post = postsBySlug.get(entry.slug);
    return post ? [post] : [];
  });
}

export function getRelatedPosts(
  slug: string,
  posts: readonly BlogPost[],
  limit = 3
): BlogPost[] {
  const topic = getBlogTopicBySlug(slug);
  if (!topic || limit <= 0) return [];

  const currentIndex = topic.entries.findIndex((entry) => entry.slug === slug);
  const pillar = topic.entries.find((entry) => entry.slug === topic.pillarSlug);
  const candidates = topic.entries
    .filter((entry) => entry.slug !== slug && entry.slug !== topic.pillarSlug)
    .sort((a, b) => {
      if (slug === topic.pillarSlug) return 0;
      const aIndex = topic.entries.indexOf(a);
      const bIndex = topic.entries.indexOf(b);
      return (
        Math.abs(aIndex - currentIndex) - Math.abs(bIndex - currentIndex) ||
        aIndex - bIndex
      );
    });

  const orderedEntries =
    slug === topic.pillarSlug || !pillar ? candidates : [pillar, ...candidates];
  const postsBySlug = new Map(posts.map((post) => [post.slug, post]));

  return orderedEntries
    .flatMap((entry) => {
      const post = postsBySlug.get(entry.slug);
      return post ? [post] : [];
    })
    .slice(0, limit);
}

export function getNextTopicBridge(
  slug: string,
  posts: readonly BlogPost[]
): { topic: BlogTopic; post: BlogPost } | undefined {
  const topicIndex = blogTopics.findIndex((topic) =>
    topic.entries.some((entry) => entry.slug === slug)
  );
  if (topicIndex === -1) return undefined;

  const nextTopic = blogTopics[(topicIndex + 1) % blogTopics.length];
  const pillar = posts.find((post) => post.slug === nextTopic.pillarSlug);
  return pillar ? { topic: nextTopic, post: pillar } : undefined;
}
