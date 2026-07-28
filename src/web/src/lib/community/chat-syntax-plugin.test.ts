import { describe, it, expect } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Root, PhrasingContent } from "mdast"
import { chatSyntaxPlugin } from "./chat-syntax-plugin"
import type { MentionNode, ChannelRefNode, ServerRefNode, MessageRefNode } from "./chat-syntax-plugin"

function parse(md: string): Root {
  const processor = unified().use(remarkParse).use(chatSyntaxPlugin)
  return processor.runSync(processor.parse(md)) as Root
}

function paragraphChildren(tree: Root): PhrasingContent[] {
  const para = tree.children[0]
  if (para?.type !== "paragraph") throw new Error("expected a paragraph")
  return para.children
}

describe("chatSyntaxPlugin — mention", () => {
  it("a hand-typed bare @name (no #dddd) is NOT a mention — stays plain text", () => {
    const children = paragraphChildren(parse("hi @Lindsay"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "hi @Lindsay" })
  })

  it("splits a @name#0042 handle into a bare mention + discriminator", () => {
    const children = paragraphChildren(parse("hi @Gus#0042"))
    expect(children[1]).toMatchObject({ type: "mention", value: "@Gus", everyone: false, discriminator: "0042" })
  })

  it("wraps a spaced-name handle as a single mention — the #dddd terminator makes this unambiguous", () => {
    const children = paragraphChildren(parse("hey @John Doe#0042 there"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@John Doe", everyone: false, discriminator: "0042" })
  })

  it("does not swallow ordinary prose ending in #dddd — the name-run must end in a non-space", () => {
    // No earlier `#`, so a naive non-greedy run would span "bob check issue "
    // and terminate at #0042. The non-space-before-# guard prevents this.
    // With message ref support, `#0042` is now parsed as a message ref (which
    // will render as a muted pill when the seq doesn't exist in the channel).
    const children = paragraphChildren(parse("@bob check issue #0042"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.map((c) => c.type)).toEqual(["text", "messageRef"])
  })

  it("keeps two adjacent handles as two distinct mentions", () => {
    const children = paragraphChildren(parse("@Alice#0001 @Bob#0002"))
    const mentions = children.filter((c): c is MentionNode => c.type === "mention")
    expect(mentions.map((m) => `${m.value}#${m.discriminator}`)).toEqual(["@Alice#0001", "@Bob#0002"])
  })

  it("does not truncate a 5+ digit run into a false-positive discriminator (still not a mention)", () => {
    // "#00423" is not a 4-digit tag, so "@Gus#00423" is NOT a mention. Since
    // message refs no longer require a leading space (Gus #94), the leading
    // 1–6 digits of the run now read as a message ref (`#00423`, 5 digits ≤ 6),
    // leaving "@Gus" as text. The key guarantee this test protects is unchanged:
    // it is NOT parsed as a mention with a truncated discriminator.
    const children = paragraphChildren(parse("hi @Gus#00423"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.map((c) => c.type)).toEqual(["text", "messageRef"])
    expect(children.find((c) => c.type === "messageRef")).toMatchObject({ value: "#00423" })
  })

  it("flags @everyone", () => {
    const children = paragraphChildren(parse("cc @everyone"))
    expect(children[1]).toMatchObject({ type: "mention", value: "@everyone", everyone: true })
  })

  it("does NOT treat @here as a mention — it was removed, renders as plain text", () => {
    // @here was removed as a broadcast trigger (plans/remove-here-mention.md,
    // option b). A literal @here is no longer a mention node; it stays text
    // (incl. historical messages — no legacy rendering).
    const children = paragraphChildren(parse("@here ping"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "@here ping" })
  })

  it("does NOT match @everyone inside a longer identifier (trailing boundary guard)", () => {
    const children = paragraphChildren(parse("@everyoneee hey"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
  })

  it("supports Unicode names in a handle (李四, José, Ünal) — the #4 charset fix", () => {
    expect(paragraphChildren(parse("hi @李四#0001"))[1]).toMatchObject({ value: "@李四", discriminator: "0001" })
    expect(paragraphChildren(parse("hi @José#0002"))[1]).toMatchObject({ value: "@José", discriminator: "0002" })
    expect(paragraphChildren(parse("hi @Ünal#0003"))[1]).toMatchObject({ value: "@Ünal", discriminator: "0003" })
  })

  it("a bare unicode @name (no tag) is NOT a mention", () => {
    expect(paragraphChildren(parse("hi @李四")).some((c) => c.type === "mention")).toBe(false)
  })

  it("leaves an @handle inside inline code literal", () => {
    const children = paragraphChildren(parse("use `@Lindsay#0001` here"))
    expect(children.map((c) => c.type)).toEqual(["text", "inlineCode", "text"])
  })

  it("leaves an @mention inside a fenced code block literal", () => {
    const tree = parse("```\n@Lindsay\n```")
    expect(tree.children.map((c) => c.type)).toEqual(["code"])
  })
})

describe("chatSyntaxPlugin — channelRef", () => {
  it("wraps /server/channel preceded by a space or at start-of-string", () => {
    expect(paragraphChildren(parse("see /studio/general"))[1]).toMatchObject({ type: "channelRef", value: "/studio/general" })
    expect(paragraphChildren(parse("/studio/general"))[0]).toMatchObject({ type: "channelRef", value: "/studio/general" })
  })

  it("leaves text/studio/general (no leading space) untouched", () => {
    const children = paragraphChildren(parse("text/studio/general"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "text/studio/general" })
  })

  it("does NOT wrap a 3+-segment docs-style path — trailing /segment fails the terminator boundary", () => {
    expect(paragraphChildren(parse("look at /api/user/123"))).toHaveLength(1)
    expect(paragraphChildren(parse("hit /docs/api/v1 first"))).toHaveLength(1)
  })

  it("still wraps a 2-segment ref followed by punctuation (period, comma, close-paren)", () => {
    const children = paragraphChildren(parse("see /studio/general."))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef", "text"])
    expect(children[1]).toMatchObject({ value: "/studio/general" })
    expect(children[2]).toMatchObject({ type: "text", value: "." })
  })

  it("wraps the thread form /studio/general/#42", () => {
    const children = paragraphChildren(parse("see /studio/general/#42"))
    expect(children[1]).toMatchObject({ type: "channelRef", value: "/studio/general/#42" })
  })

  it("wraps the thread-reply form /studio/general/#5#42 as a single channelRef node", () => {
    const children = paragraphChildren(parse("see /studio/general/#5#42 done"))
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ type: "channelRef", value: "/studio/general/#5#42" })
  })

  it("does not wrap a mid-string thread-reply path as a channelRef (leading-space boundary still applies to CHANNEL refs)", () => {
    // The channelRef pass still requires a leading space, so `text/.../#5#42`
    // is NOT a channelRef. But message refs no longer require a leading space
    // (Gus #94), so the trailing `#42` (a bare `#`+digits token) now reads as a
    // message ref. The channelRef guarantee this test protects — no channelRef
    // mid-string — is unchanged.
    const children = paragraphChildren(parse("text/studio/general/#5#42"))
    expect(children.some((c) => c.type === "channelRef")).toBe(false)
    expect(children.find((c) => c.type === "messageRef")).toMatchObject({ value: "#42" })
  })

  it("leaves a channel-ref-shaped path inside inline code literal", () => {
    const children = paragraphChildren(parse("`/studio/general`"))
    expect(children.map((c) => c.type)).toEqual(["inlineCode"])
  })

  it("does not double-match a community invite URL — the 3-segment /community/invite/<token> path never satisfies the 2-segment terminator boundary", () => {
    const bare = paragraphChildren(parse("join /community/invite/abc123XYZ"))
    expect(bare).toHaveLength(1)
    expect(bare[0]).toMatchObject({ type: "text", value: "join /community/invite/abc123XYZ" })

    const full = paragraphChildren(parse("join https://alook.ai/community/invite/xY9k2vW7aQ"))
    expect(full.some((c) => c.type === "channelRef")).toBe(false)
  })

  it("wraps a ref with a Chinese channel name — slugify preserves CJK, the charset must match it", () => {
    // The bug Shelly reported (#194): names are slugified display names, not
    // nanoid ids; slugify keeps CJK/emoji, so an ASCII-only charset dropped the pill.
    expect(paragraphChildren(parse("see /Gus/架构"))[1]).toMatchObject({ type: "channelRef", value: "/Gus/架构" })
    expect(paragraphChildren(parse("/Gus/架构"))[0]).toMatchObject({ type: "channelRef", value: "/Gus/架构" })
  })

  it("wraps a ref with emoji in the server segment (slugify keeps emoji, e.g. \"总部 🎉\" → \"总部-🎉\")", () => {
    const children = paragraphChildren(parse("go /总部-🎉/general now"))
    expect(children.find((c) => c.type === "channelRef")).toMatchObject({ value: "/总部-🎉/general" })
  })

  it("wraps a ref with accented-Latin name (café)", () => {
    expect(paragraphChildren(parse("see /studio/café done"))[1]).toMatchObject({ type: "channelRef", value: "/studio/café" })
  })

  it("wraps the thread form on a Unicode name — /Gus/架构/#42", () => {
    expect(paragraphChildren(parse("see /Gus/架构/#42"))[1]).toMatchObject({ type: "channelRef", value: "/Gus/架构/#42" })
  })

  it("still terminates a Unicode ref at a trailing ASCII period — the period is not swallowed", () => {
    // Regression guard for the Unicode charset: the segment class must stay
    // disjoint from the terminator punctuation, else a greedy match eats the `.`.
    const children = paragraphChildren(parse("see /Gus/架构."))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef", "text"])
    expect(children[1]).toMatchObject({ value: "/Gus/架构" })
    expect(children[2]).toMatchObject({ type: "text", value: "." })
  })

  it("terminates a Unicode ref at a trailing FULL-WIDTH period 。 — the most common CJK sentence ender", () => {
    // Blair's QA flag: a Chinese sentence ends in 。, so the ref-in-a-sentence
    // shape `看 /Gus/架构。` is extremely common. The full-width 。 must be a
    // terminator (in BOTH the segment-exclusion and the lookahead — the segment
    // is greedy, so lookahead-only would let it swallow the 。), else the pill
    // target becomes "架构。" and click/highlight mis-targets the real channel.
    const children = paragraphChildren(parse("看 /Gus/架构。"))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef", "text"])
    expect(children[1]).toMatchObject({ value: "/Gus/架构" })
    expect(children[2]).toMatchObject({ type: "text", value: "。" })
  })

  it("terminates at other full-width CJK terminators (！？ etc.)", () => {
    expect(paragraphChildren(parse("用 /Gus/架构！"))[1]).toMatchObject({ value: "/Gus/架构" })
    expect(paragraphChildren(parse("是 /Gus/架构？好"))[1]).toMatchObject({ value: "/Gus/架构" })
  })
})

describe("chatSyntaxPlugin — serverRef", () => {
  it("wraps a bare /server preceded by a space or at start-of-string", () => {
    expect(paragraphChildren(parse("check /studio"))[1]).toMatchObject({ type: "serverRef", value: "/studio" })
    expect(paragraphChildren(parse("/studio"))[0]).toMatchObject({ type: "serverRef", value: "/studio" })
  })

  it("does not double-match the first segment of a /server/channel ref", () => {
    const children = paragraphChildren(parse("see /studio/general"))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef"])
    expect(children.some((c) => c.type === "serverRef")).toBe(false)
  })

  it("leaves text/studio (no leading space) untouched", () => {
    const children = paragraphChildren(parse("text/studio"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "text/studio" })
  })

  it("still wraps a bare ref followed by punctuation", () => {
    const children = paragraphChildren(parse("see /studio."))
    expect(children.map((c) => c.type)).toEqual(["text", "serverRef", "text"])
    expect(children[1]).toMatchObject({ value: "/studio" })
  })

  it("leaves a server-ref-shaped path inside inline code literal", () => {
    const children = paragraphChildren(parse("`/studio`"))
    expect(children.map((c) => c.type)).toEqual(["inlineCode"])
  })

  it("does not match the invite URL's first segment", () => {
    const bare = paragraphChildren(parse("join /community/invite/abc123XYZ"))
    expect(bare).toHaveLength(1)
    expect(bare.some((c) => c.type === "serverRef")).toBe(false)
  })

  it("wraps a bare Unicode /server ref (Chinese, emoji)", () => {
    expect(paragraphChildren(parse("check /架构"))[1]).toMatchObject({ type: "serverRef", value: "/架构" })
    expect(paragraphChildren(parse("check /总部-🎉 here"))[1]).toMatchObject({ type: "serverRef", value: "/总部-🎉" })
  })

  it("terminates a Unicode /server ref at trailing punctuation (ASCII + full-width)", () => {
    const ascii = paragraphChildren(parse("check /架构."))
    expect(ascii.map((c) => c.type)).toEqual(["text", "serverRef", "text"])
    expect(ascii[1]).toMatchObject({ value: "/架构" })

    const cjk = paragraphChildren(parse("去 /架构。"))
    expect(cjk.map((c) => c.type)).toEqual(["text", "serverRef", "text"])
    expect(cjk[1]).toMatchObject({ value: "/架构" })
    expect(cjk[2]).toMatchObject({ type: "text", value: "。" })
  })
})

describe("chatSyntaxPlugin — message ref", () => {
  it("parses space + #NUMBER as messageRef", () => {
    const children = paragraphChildren(parse("see #123"))
    const messageRef = children.find((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRef).toMatchObject({ type: "messageRef", value: "#123" })
  })

  it("parses #NUMBER at line start as messageRef", () => {
    const children = paragraphChildren(parse("#42 was fixed"))
    const messageRef = children.find((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRef).toMatchObject({ type: "messageRef", value: "#42" })
  })

  it("parses text#NUMBER glued to a preceding word as messageRef (no leading space needed)", () => {
    // Reversed from the old "avoid GitHub issue#42" rule: agents dislike
    // prepending a space, so a `#N` glued to a word must still pill (Gus #94,
    // approved #105). GitHub-style `issue#42` now renders as a message ref.
    const children = paragraphChildren(parse("issue#42 in GitHub"))
    const messageRef = children.find((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRef).toMatchObject({ type: "messageRef", value: "#42" })
    // The word before keeps its text; only the #42 becomes a ref.
    expect(children[0]).toMatchObject({ type: "text", value: "issue" })
  })

  it("parses #NUMBER with NO space in various glued forms", () => {
    expect(paragraphChildren(parse("text#123")).find((c) => c.type === "messageRef")).toMatchObject({ value: "#123" })
    // CJK glued form + full-width terminator: 见#42。 → msgref #42 + literal 。
    const cjk = paragraphChildren(parse("见#42。"))
    expect(cjk.find((c) => c.type === "messageRef")).toMatchObject({ value: "#42" })
    expect(cjk.some((c) => c.type === "text" && c.value === "。")).toBe(true)
  })

  it("a valid @name#0042 handle is still a mention, not a name + message ref (mention pass runs first)", () => {
    // Dropping the leading-space boundary must NOT split #0042 out of a real
    // mention — the mention pass runs before the message-ref pass and consumes
    // the whole handle.
    const children = paragraphChildren(parse("@Alice#0042"))
    expect(children.some((c) => c.type === "messageRef")).toBe(false)
    expect(children[0]).toMatchObject({ type: "mention", value: "@Alice", discriminator: "0042" })
  })

  it("an INVALID @name#42 (2-digit, not a mention) now yields text + message ref #42", () => {
    // Documented consequence: @Alice#42 isn't a valid 4-digit handle, so it's
    // not a mention; with the leading boundary gone, its #42 reads as a msgref.
    const children = paragraphChildren(parse("@Alice#42"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.find((c) => c.type === "messageRef")).toMatchObject({ value: "#42" })
  })

  it("parses multiple message refs in one message", () => {
    const children = paragraphChildren(parse("See #10 and #20"))
    const messageRefs = children.filter((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRefs.map((m) => m.value)).toEqual(["#10", "#20"])
  })

  it("does NOT parse inside code blocks", () => {
    const children = paragraphChildren(parse("`#42`"))
    expect(children.some((c) => c.type === "messageRef")).toBe(false)
  })

  it("parses #NUMBER with trailing punctuation", () => {
    const children = paragraphChildren(parse("Fixed in #123."))
    const messageRef = children.find((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRef).toMatchObject({ value: "#123" })
  })

  it("does NOT parse 7+ digit numbers", () => {
    const children = paragraphChildren(parse("ref #9999999"))
    expect(children.some((c) => c.type === "messageRef")).toBe(false)
  })

  it("CONSEQUENCE of no-leading-space: a numeric URL fragment now reads as a message ref", () => {
    // Documented tradeoff of Gus #94 (approved #105): dropping the leading
    // boundary means `…#42` glued to a URL becomes a message-ref pill.
    // `github.com/foo/bar#42` → text + messageRef `#42`. Non-numeric fragments
    // (`#section`) are unaffected. Flagged to Gus; this test pins the behavior
    // so it's a deliberate decision, not a silent regression.
    const numeric = paragraphChildren(parse("see github.com/foo/bar#42"))
    expect(numeric.find((c) => c.type === "messageRef")).toMatchObject({ value: "#42" })

    const nonNumeric = paragraphChildren(parse("see example.com/page#section"))
    expect(nonNumeric.some((c) => c.type === "messageRef")).toBe(false)
  })
})

describe("chatSyntaxPlugin — mixed", () => {
  it("handles a mix of mention, channelRef, and unrelated formatting in one message", () => {
    const children = paragraphChildren(parse("Here's the **setup**: `pnpm install` ping @Gus#0042 in /studio/dev"))
    const types = children.map((c) => c.type)
    expect(types).toContain("strong")
    expect(types).toContain("inlineCode")
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus", discriminator: "0042" })
    const channelRef = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(channelRef).toMatchObject({ value: "/studio/dev" })
  })

  it("handles a mention and a bare serverRef together", () => {
    const children = paragraphChildren(parse("ping @Gus#0042, see /studio for context"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus", discriminator: "0042" })
    const serverRef = children.find((c): c is ServerRefNode => c.type === "serverRef")
    expect(serverRef).toMatchObject({ value: "/studio" })
  })

  it("handles mention, message ref, and channel ref together", () => {
    const children = paragraphChildren(parse("@Alice#0001 check #42 in /studio/general"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Alice", discriminator: "0001" })
    const messageRef = children.find((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRef).toMatchObject({ value: "#42" })
    const channelRef = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(channelRef).toMatchObject({ value: "/studio/general" })
  })
})
