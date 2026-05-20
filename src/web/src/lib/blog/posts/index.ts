import type { BlogPost } from "../types";

import { metadata as whyWeBuiltAlook } from "@/content/why-we-built-alook.mdx";
import { metadata as buildingYourFirstAgentTeam } from "@/content/building-your-first-agent-team.mdx";

const posts: BlogPost[] = [buildingYourFirstAgentTeam, whyWeBuiltAlook];

export type { BlogPost } from "../types";

export function getAllPosts(): BlogPost[] {
  return [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}
