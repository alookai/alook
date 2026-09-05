import { describe, expect, it } from "vitest"
import { matchPlatformLink } from "./platform-link"

describe("matchPlatformLink", () => {
  it.each([
    ["https://alook.ai/c/invite/abcdef", "alook", "Alook"],
    ["https://www.alook.ai/c/invite/abcdef", "alook", "Alook"],
    ["http://localhost:3000/c/me", "local", "Local"],
    ["http://app.localhost:8787/preview", "local", "Local"],
    ["http://127.0.0.1:3000/c/me", "local", "Local"],
    ["http://127.12.34.56:8787/preview", "local", "Local"],
    ["http://0.0.0.0:3000/c/me", "local", "Local"],
    ["http://[::1]:3000/c/me", "local", "Local"],
    ["http://[::ffff:127.0.0.1]:3000/c/me", "local", "Local"],
    ["https://github.com/alookai/alook/pull/598", "github", "GitHub"],
    ["https://gist.github.com/alookai/abc", "github", "GitHub"],
    ["https://gitlab.com/alookai/alook/-/merge_requests/1", "gitlab", "GitLab"],
    ["https://x.com/alookai/status/1", "x", "X"],
    ["https://mobile.twitter.com/alookai/status/1", "x", "X"],
    ["https://old.reddit.com/r/LocalLLaMA/comments/abc", "reddit", "Reddit"],
    ["https://redd.it/abc", "reddit", "Reddit"],
    ["https://youtu.be/abc", "youtube", "YouTube"],
    ["https://www.youtube.com/watch?v=abc", "youtube", "YouTube"],
    ["https://www.figma.com/design/abc", "figma", "Figma"],
    ["https://workspace.notion.site/Page-abc", "notion", "Notion"],
    ["https://discord.gg/abc", "discord", "Discord"],
    ["https://linear.app/alook/issue/ALO-123", "linear", "Linear"],
    ["https://docs.google.com/document/d/abc/edit", "google-drive", "Google Drive"],
    ["https://drive.google.com/file/d/abc/view", "google-drive", "Google Drive"],
    ["https://developers.cloudflare.com/workers/", "cloudflare", "Cloudflare"],
    ["https://alook.vercel.app/preview", "vercel", "Vercel"],
    ["https://www.npmjs.com/package/@alook/daemon", "npm", "npm"],
    ["https://www.loom.com/share/abc", "loom", "Loom"],
    ["https://platform.openai.com/docs", "openai", "OpenAI"],
    ["https://chatgpt.com/c/abc", "openai", "OpenAI"],
    ["https://docs.anthropic.com/en/docs", "anthropic", "Anthropic"],
    ["https://claude.ai/chat/abc", "anthropic", "Anthropic"],
    ["https://claude.com/product", "anthropic", "Anthropic"],
    ["https://stackoverflow.com/questions/1/example", "stackoverflow", "Stack Overflow"],
    ["https://news.ycombinator.com/item?id=1", "hacker-news", "Hacker News"],
    ["https://alook.substack.com/p/example", "substack", "Substack"],
    ["https://medium.com/@alook/example", "medium", "Medium"],
    ["https://dev.to/alook/example", "dev-community", "DEV Community"],
    ["https://alook.hashnode.com/example", "hashnode", "Hashnode"],
    ["https://www.producthunt.com/posts/alook", "product-hunt", "Product Hunt"],
    ["https://arxiv.org/abs/2609.00001", "arxiv", "arXiv"],
    ["https://en.wikipedia.org/wiki/Multi-agent_system", "wikipedia", "Wikipedia"],
    ["https://www.zhihu.com/question/1", "zhihu", "Zhihu"],
    ["https://www.xiaohongshu.com/explore/abc", "xiaohongshu", "Xiaohongshu"],
    ["https://xhslink.com/a/abc", "xiaohongshu", "Xiaohongshu"],
  ])("recognizes %s", (href, kind, label) => {
    expect(matchPlatformLink(href)).toEqual({ kind, label })
  })

  it.each([
    "https://github.com.evil.example/alookai/alook",
    "https://notgithub.com/alookai/alook",
    "https://alook.ai.evil.example/c/invite/abcdef",
    "https://127.0.0.1.evil.example/c/me",
    "https://notlinear.app/alook/issue/ALO-123",
    "https://example.com/story",
    "ftp://github.com/alookai/alook",
    "/c/invite/abcdef",
    "not a URL",
    undefined,
  ])("does not badge unsupported or unsafe input: %s", (href) => {
    expect(matchPlatformLink(href)).toBeNull()
  })
})
