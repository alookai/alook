import { describe, expect, it } from "vitest"
import { matchPlatformLink } from "./platform-link"

describe("matchPlatformLink", () => {
  it.each([
    ["https://alook.ai/c/invite/abcdef", "alook", "Alook"],
    ["https://www.alook.ai/c/invite/abcdef", "alook", "Alook"],
    ["https://github.com/alookai/alook/pull/598", "github", "GitHub"],
    ["https://gist.github.com/alookai/abc", "github", "GitHub"],
    ["https://x.com/alookai/status/1", "x", "X"],
    ["https://mobile.twitter.com/alookai/status/1", "x", "X"],
    ["https://old.reddit.com/r/LocalLLaMA/comments/abc", "reddit", "Reddit"],
    ["https://redd.it/abc", "reddit", "Reddit"],
    ["https://youtu.be/abc", "youtube", "YouTube"],
    ["https://www.youtube.com/watch?v=abc", "youtube", "YouTube"],
    ["https://www.figma.com/design/abc", "figma", "Figma"],
    ["https://workspace.notion.site/Page-abc", "notion", "Notion"],
    ["https://discord.gg/abc", "discord", "Discord"],
  ])("recognizes %s", (href, kind, label) => {
    expect(matchPlatformLink(href)).toEqual({ kind, label })
  })

  it.each([
    "https://github.com.evil.example/alookai/alook",
    "https://notgithub.com/alookai/alook",
    "https://alook.ai.evil.example/c/invite/abcdef",
    "https://example.com/story",
    "ftp://github.com/alookai/alook",
    "/c/invite/abcdef",
    "not a URL",
    undefined,
  ])("does not badge unsupported or unsafe input: %s", (href) => {
    expect(matchPlatformLink(href)).toBeNull()
  })
})
