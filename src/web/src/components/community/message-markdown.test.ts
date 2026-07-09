import { describe, it, expect } from "vitest"
import { escapeHtml, preprocessMarkdown, extractInviteTokens } from "./message-markdown"

describe("escapeHtml", () => {
  it("neutralizes < and &, keeps > for blockquotes", () => {
    expect(escapeHtml("a < b && c")).toBe("a &lt; b &amp;&amp; c")
    expect(escapeHtml("> quote")).toBe("> quote")
  })
})

describe("preprocessMarkdown", () => {
  it("wraps spoilers", () => {
    expect(preprocessMarkdown("psst ||secret||")).toBe("psst <spoiler>secret</spoiler>")
  })

  it("wraps @user mentions", () => {
    expect(preprocessMarkdown("hi @Lindsay")).toBe("hi <mention>@Lindsay</mention>")
  })

  it("flags @everyone / @here", () => {
    expect(preprocessMarkdown("cc @everyone")).toBe('cc <mention data-everyone="1">@everyone</mention>')
    expect(preprocessMarkdown("@here ping")).toBe('<mention data-everyone="1">@here</mention> ping')
  })

  it("wraps #channel and preserves the leading separator", () => {
    expect(preprocessMarkdown("see #general")).toBe("see <channel>#general</channel>")
    expect(preprocessMarkdown("#general")).toBe("<channel>#general</channel>")
  })

  it("leaves @ / # / || inside inline code literal", () => {
    expect(preprocessMarkdown("use `@Lindsay` here")).toBe("use `@Lindsay` here")
    expect(preprocessMarkdown("`#general`")).toBe("`#general`")
    expect(preprocessMarkdown("`||x||`")).toBe("`||x||`")
  })

  it("leaves content inside fenced code literal", () => {
    const fenced = "```\n@Lindsay #general ||x||\n```"
    expect(preprocessMarkdown(fenced)).toBe(fenced)
  })

  it("inserts a blank line before a `> ` quote that follows text", () => {
    expect(preprocessMarkdown("steps:\n> do it")).toBe("steps:\n\n> do it")
  })

  it("leaves community invite URLs literal in the body (auto-link handles them)", () => {
    // Preprocess no longer rewrites invite URLs — they stay as plain text so
    // streamdown auto-links them; the card renders separately via
    // extractInviteTokens.
    expect(preprocessMarkdown("join /community/invite/abc123XYZ")).toBe(
      "join /community/invite/abc123XYZ",
    )
  })

  it("handles a mix and round-trips stashed code unchanged", () => {
    const input = "Here's the **setup**:\n> Clone the repo\n`pnpm install`\nping @Gus in #dev"
    const out = preprocessMarkdown(input)
    expect(out).toContain("**setup**")
    expect(out).toContain("\n\n> Clone the repo")
    expect(out).toContain("`pnpm install`")
    expect(out).toContain("<mention>@Gus</mention>")
    expect(out).toContain("<channel>#dev</channel>")
  })
})

describe("extractInviteTokens", () => {
  it("extracts a bare-path token", () => {
    expect(extractInviteTokens("join /community/invite/abc123XYZ")).toEqual(["abc123XYZ"])
  })

  it("extracts a full-origin URL token", () => {
    expect(extractInviteTokens("https://alook.ai/community/invite/xY9k2vW7aQ")).toEqual([
      "xY9k2vW7aQ",
    ])
  })

  it("extracts tokens with underscore/dash (nanoid alphabet)", () => {
    expect(extractInviteTokens("/community/invite/ab_cd-EF12")).toEqual(["ab_cd-EF12"])
  })

  it("dedupes repeated tokens in the same message", () => {
    expect(
      extractInviteTokens(
        "/community/invite/abc123XYZ /community/invite/abc123XYZ /community/invite/other456",
      ),
    ).toEqual(["abc123XYZ", "other456"])
  })

  it("ignores tokens below the 6-char floor", () => {
    expect(extractInviteTokens("/community/invite/abc")).toEqual([])
  })

  it("returns [] when the message has no invite URL", () => {
    expect(extractInviteTokens("hello world")).toEqual([])
  })
})
