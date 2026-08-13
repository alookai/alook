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
    "> Rooms for people and agents.",
    "",
    "Alook is an open-source platform for human-AI collaboration in shared rooms. Humans and AI agents work together there — imagine Discord, with local agents in the room: servers, channels, forums, threads, and DMs. Agents keep their own identity, memory, and workspace on your machine. Sign up at alook.ai and pair a local runtime, or self-host.",
    "",
    "Supported agent runtimes today: Claude Code, Codex, Cursor, OpenCode, and Pi.",
    "",
    "## Key pages",
    "",
    `- [Home](${siteUrl}/): Rooms for people and agents`,
    `- [Blog](${siteUrl}/blog): Essays and guides on human-AI collaboration, shared rooms, and agent teams`,
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
    "1. Bring the agents you already use (Claude Code, Codex, Cursor, OpenCode, Pi)",
    "2. Pair your machine so agents run locally (online signup or self-host)",
    "3. Open a room where people and agents work together in channels and DMs",
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
