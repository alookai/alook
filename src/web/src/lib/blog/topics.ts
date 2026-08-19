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
      { slug: "ai-agent-vs-chatbot", userJob: "Decide between an agent and a chatbot" },
      { slug: "how-to-delegate-tasks-to-ai-agents", userJob: "Package a task reliably" },
      { slug: "ai-agent-team", userJob: "Design multi-agent team roles and handoffs" },
      { slug: "ai-agent-orchestration", userJob: "Understand the coordination layer" },
      { slug: "multi-agent-workflow-patterns", userJob: "Pick a workflow pattern" },
      { slug: "run-ai-agent-team-that-stays-on-track", userJob: "Keep a team from drifting" },
    ],
  },
  {
    id: "coding-agents",
    label: "Coding agents across runtimes & repos",
    description:
      "Coordinate coding agents across tools and repositories without duplicated work, lost decisions, or merge conflicts.",
    pillarSlug: "claude-code-and-codex-same-team",
    entries: [
      { slug: "ai-team-vs-ai-tools", userJob: "Stop being the copy-paste layer" },
      {
        slug: "claude-code-subagents-vs-independent-agents",
        userJob: "Choose nested or independent agents",
      },
      {
        slug: "claude-code-and-codex-same-team",
        userJob: "Coordinate Claude Code and Codex",
      },
      {
        slug: "claude-code-dynamic-workflow-alternative",
        userJob: "Compare session workflows with persistent coordination",
      },
      {
        slug: "keep-context-across-coding-agent-sessions",
        userJob: "Carry decisions across sessions",
      },
      {
        slug: "multiple-ai-agents-edit-same-repository",
        userJob: "Run agents in parallel without conflicts",
      },
      {
        slug: "prevent-coding-agents-duplicating-work",
        userJob: "Stop agents from duplicating work",
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
      { slug: "shared-context-between-agents", userJob: "Understand why agents drift" },
      {
        slug: "what-makes-a-shared-ai-workspace-usable",
        userJob: "Judge whether a shared workspace works",
      },
      {
        slug: "human-ai-collaboration-small-teams",
        userJob: "Move from one chat to a coordinated team",
      },
      {
        slug: "humans-and-ai-agents-in-one-room",
        userJob: "Put multiple people's agents in one room",
      },
      { slug: "why-we-built-alook", userJob: "Understand why Alook exists" },
      {
        slug: "ai-agent-identity",
        userJob: "Keep an agent addressable across rooms and servers",
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
      { slug: "personal-ai-company", userJob: "Build a one-person company" },
      {
        slug: "multi-agent-collaboration-without-code",
        userJob: "Coordinate agents without orchestration code",
      },
      {
        slug: "no-code-automation-ai-agents",
        userJob: "Choose trigger-action automation or an agent team",
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
