import type { BlogPost } from "./types";

export const LLMS_TXT_SITE_URL = "https://alook.ai";

function formatPostDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function postSummary(post: BlogPost): string {
  const summary = post.agentSummary?.trim() || post.excerpt.trim();
  return summary;
}

export function buildLlmsTxt(
  posts: BlogPost[],
  siteUrl: string = LLMS_TXT_SITE_URL
): string {
  const blogLines =
    posts.length === 0
      ? ["- No published posts yet."]
      : posts.map((post) => {
          const summary = postSummary(post);
          return `- [${post.title}](${siteUrl}/blog/${post.slug}) — ${post.author}, published ${formatPostDate(post.date)}. ${summary}`;
        });

  return [
    "# Alook",
    "",
    "> Connect your own agents and run them as one coordinated team.",
    "",
    "Alook is an open-source, self-hosted platform that turns local AI agents into a collaborating team. Give agents roles, email addresses, tasks, and shared coordination so you stop routing context by hand. Sign up at alook.ai and connect your local runtime, or self-host.",
    "",
    "Supported agent runtimes today: Claude Code, Codex, and OpenCode.",
    "",
    "## Key pages",
    "",
    `- [Home](${siteUrl}/): Product overview and onboarding`,
    `- [Blog](${siteUrl}/blog): Essays and guides on agent teams and coordination`,
    `- [Blog RSS](${siteUrl}/blog/feed.xml): Machine-readable post feed`,
    `- [GitHub](https://github.com/alookai/alook): Source code and self-host path`,
    `- [Discord](https://discord.alook.ai): Community`,
    "",
    "## Blog posts",
    "",
    ...blogLines,
    "",
    "## Machine-readable surfaces",
    "",
    `- This index: ${siteUrl}/llms.txt`,
    `- Blog RSS: ${siteUrl}/blog/feed.xml`,
    "",
    "## How Alook fits",
    "",
    "1. Bring agents you already run (Claude Code, Codex, OpenCode, …)",
    "2. Connect your local runtime (online signup or self-host)",
    "3. Coordinate as a team: roles, handoffs, email reachability, human review",
    "",
    "## Contact",
    "",
    `- Website: ${siteUrl}`,
    "- GitHub: https://github.com/alookai/alook",
    "- Discord: https://discord.alook.ai",
    "- X: https://x.com/alook_ai",
    "- Support: support@alook.ai",
    "",
  ].join("\n");
}
