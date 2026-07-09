import { describe, it, expect, vi } from "vitest"
import {
  escapeHtml,
  preprocessMarkdown,
  extractInviteTokens,
  mentionNameFromText,
  buildMdComponents,
  MD_COMPONENTS,
} from "./message-markdown"

// `components.mention(...)` returns a plain React element (JSX under the
// hood) — inspecting `.props` here reaches into the MentionPill it wraps
// without a jsdom/testing-library render pass (this repo runs vitest under
// node, see the other describe blocks in this file).
type MentionElement = { props: { onClick?: (e: unknown) => void } }

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

  it("wraps a full @name#0042 handle as a single mention token, hiding the discriminator from display but keeping it as a data-tag", () => {
    expect(preprocessMarkdown("hi @Gus#0042")).toBe('hi <mention data-tag="0042">@Gus</mention>')
  })

  it("doesn't truncate a 5+ digit run into a false-positive handle", () => {
    expect(preprocessMarkdown("hi @Gus#00423")).toBe("hi <mention>@Gus</mention>#00423")
  })

  it("flags @everyone / @here", () => {
    expect(preprocessMarkdown("cc @everyone")).toBe('cc <mention data-everyone="1">@everyone</mention>')
    expect(preprocessMarkdown("@here ping")).toBe('<mention data-everyone="1">@here</mention> ping')
  })

  it("the old #channel step/tag no longer exists — #general renders as plain text", () => {
    // Regression guard for the retired legacy chip (plan community-channel-ref.md).
    expect(preprocessMarkdown("see #general")).toBe("see #general")
    expect(preprocessMarkdown("#general")).toBe("#general")
  })

  it("wraps /server/channel preceded by a space or at start-of-string into <channelref>, preserving the leading separator outside the tag", () => {
    expect(preprocessMarkdown("see /studio/general")).toBe("see <channelref>/studio/general</channelref>")
    expect(preprocessMarkdown("/studio/general")).toBe("<channelref>/studio/general</channelref>")
  })

  it("leaves text/studio/general (no leading space) untouched", () => {
    expect(preprocessMarkdown("text/studio/general")).toBe("text/studio/general")
  })

  it("does NOT wrap a 3+-segment docs-style path — trailing `/segment` fails the terminator boundary", () => {
    // Regression guard: `CHANNEL_REF_REGEX` used to greedily eat `/api/user`
    // out of a docs URL, orphaning `/123` as broken trailing text next to a
    // muted pill. The trailing boundary lookahead rejects this — a real
    // 2-segment ref must sit alone (space, EOS, or punctuation after it).
    expect(preprocessMarkdown("look at /api/user/123")).toBe("look at /api/user/123")
    expect(preprocessMarkdown("hit /docs/api/v1 first")).toBe("hit /docs/api/v1 first")
  })

  it("still wraps a 2-segment ref followed by punctuation (period, comma, close-paren)", () => {
    expect(preprocessMarkdown("see /studio/general.")).toBe(
      "see <channelref>/studio/general</channelref>.",
    )
    expect(preprocessMarkdown("visit /studio/general, ok?")).toBe(
      "visit <channelref>/studio/general</channelref>, ok?",
    )
    expect(preprocessMarkdown("(see /studio/general)")).toBe(
      "(see <channelref>/studio/general</channelref>)",
    )
  })

  it("wraps the thread form /studio/general/#42", () => {
    expect(preprocessMarkdown("see /studio/general/#42")).toBe(
      "see <channelref>/studio/general/#42</channelref>",
    )
  })

  it("leaves @ / # / || / channel-refs inside inline code literal", () => {
    expect(preprocessMarkdown("use `@Lindsay` here")).toBe("use `@Lindsay` here")
    expect(preprocessMarkdown("`#general`")).toBe("`#general`")
    expect(preprocessMarkdown("`||x||`")).toBe("`||x||`")
    expect(preprocessMarkdown("`/studio/general`")).toBe("`/studio/general`")
  })

  it("leaves content inside fenced code literal", () => {
    const fenced = "```\n@Lindsay #general /studio/general ||x||\n```"
    expect(preprocessMarkdown(fenced)).toBe(fenced)
  })

  it("inserts a blank line before a `> ` quote that follows text", () => {
    expect(preprocessMarkdown("steps:\n> do it")).toBe("steps:\n\n> do it")
  })

  it("leaves community invite URLs literal in the body (auto-link handles them) — regression guard for the invite-URL stash fix", () => {
    // Preprocess no longer rewrites invite URLs — they stay as plain text so
    // streamdown auto-links them; the card renders separately via
    // extractInviteTokens. Must round-trip COMPLETELY unchanged (literal
    // equality, not just `.toContain()`) — this confirms invite URLs are
    // stashed BEFORE `CHANNEL_REF_REGEX` runs (which would otherwise
    // shape-match `/community/invite` as a two-segment channel ref and split
    // the URL across a `<channelref>` tag boundary, breaking streamdown's
    // GFM autolink of the whole URL).
    expect(preprocessMarkdown("join /community/invite/abc123XYZ")).toBe(
      "join /community/invite/abc123XYZ",
    )
  })

  it("regression guard: the full-origin invite URL form also round-trips unchanged", () => {
    expect(preprocessMarkdown("join https://alook.ai/community/invite/xY9k2vW7aQ")).toBe(
      "join https://alook.ai/community/invite/xY9k2vW7aQ",
    )
  })

  it("handles a mix and round-trips stashed code unchanged", () => {
    const input = "Here's the **setup**:\n> Clone the repo\n`pnpm install`\nping @Gus in /studio/dev"
    const out = preprocessMarkdown(input)
    expect(out).toContain("**setup**")
    expect(out).toContain("\n\n> Clone the repo")
    expect(out).toContain("`pnpm install`")
    expect(out).toContain("<mention>@Gus</mention>")
    expect(out).toContain("<channelref>/studio/dev</channelref>")
  })
})

describe("mentionNameFromText", () => {
  it("strips the leading @", () => {
    expect(mentionNameFromText("@Gus")).toBe("Gus")
  })

  it("strips a trailing #0042 discriminator", () => {
    expect(mentionNameFromText("@Gus#0042")).toBe("Gus")
  })

  it("leaves a 5+ digit trailing run alone (not a valid discriminator)", () => {
    expect(mentionNameFromText("@Gus#00423")).toBe("Gus#00423")
  })

  it("leaves @everyone / @here as-is (no discriminator to strip)", () => {
    expect(mentionNameFromText("@everyone")).toBe("everyone")
    expect(mentionNameFromText("@here")).toBe("here")
  })
})

describe("buildMdComponents — mention pill onClick wiring", () => {
  it("wires onClick to call onOpenProfile with the name (no @, no #dddd) and no discriminator when the tag wasn't stashed", () => {
    const onOpenProfile = vi.fn()
    const components = buildMdComponents(onOpenProfile)
    const el = components.mention({ children: "@Gus#0042" }) as unknown as MentionElement
    const fakeEvent = {} as never
    el.props.onClick?.(fakeEvent)
    expect(onOpenProfile).toHaveBeenCalledWith("Gus", fakeEvent, undefined)
  })

  it("forwards the stashed data-tag discriminator so same-named members can be disambiguated", () => {
    const onOpenProfile = vi.fn()
    const components = buildMdComponents(onOpenProfile)
    const el = components.mention({ children: "@Gus", "data-tag": "0042" }) as unknown as MentionElement
    const fakeEvent = {} as never
    el.props.onClick?.(fakeEvent)
    expect(onOpenProfile).toHaveBeenCalledWith("Gus", fakeEvent, "0042")
  })

  it("does not wire onClick for @everyone / @here", () => {
    const onOpenProfile = vi.fn()
    const components = buildMdComponents(onOpenProfile)
    const el = components.mention({ children: "@everyone", "data-everyone": "1" }) as unknown as MentionElement
    expect(el.props.onClick).toBeUndefined()
  })

  it("has no onClick when no onOpenProfile callback is given", () => {
    const components = buildMdComponents(undefined)
    const el = components.mention({ children: "@Gus" }) as unknown as MentionElement
    expect(el.props.onClick).toBeUndefined()
  })

  it("MD_COMPONENTS.mention (the static, no-callback default) has no onClick", () => {
    const el = MD_COMPONENTS.mention({ children: "@Gus" }) as unknown as MentionElement
    expect(el.props.onClick).toBeUndefined()
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
