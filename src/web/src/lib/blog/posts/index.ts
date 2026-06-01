import type { BlogPost } from "../types";

import { metadata as whyWeBuiltAlook } from "@/content/why-we-built-alook.mdx";
import { metadata as aiAgentOrchestration } from "@/content/ai-agent-orchestration.mdx";
import { metadata as aiAgentVsChatbot } from "@/content/ai-agent-vs-chatbot.mdx";
import { metadata as howToDelegateTasks } from "@/content/how-to-delegate-tasks-to-ai-agents.mdx";

const posts: BlogPost[] = [
  whyWeBuiltAlook,
  aiAgentOrchestration,
  aiAgentVsChatbot,
  howToDelegateTasks,
];

export type { BlogPost } from "../types";

export function getAllPosts(): BlogPost[] {
  return [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}
