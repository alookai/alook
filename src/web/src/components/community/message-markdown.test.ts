import { describe, it, expect } from "vitest"
import { escapeHtml, preprocessMarkdown } from "./message-markdown"

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
