import { describe, it, expect } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Root, PhrasingContent } from "mdast"
import { chatSyntaxPlugin } from "./chat-syntax-plugin"
import { buildCliSystemPrompt } from "../../../../daemon/src/drivers/systemPrompt"
import type { MentionNode, ChannelRefNode, ServerRefNode } from "./chat-syntax-plugin"

function parse(md: string): Root {
  const processor = unified().use(remarkParse).use(chatSyntaxPlugin)
  return processor.runSync(processor.parse(md)) as Root
}

function paragraphChildren(tree: Root): PhrasingContent[] {
  const para = tree.children[0]
  if (para?.type !== "paragraph") throw new Error("expected a paragraph")
  return para.children
}

describe("CLI prompt ref examples — tokenizer contract", () => {
  it("turns every emitted copyable example into the intended ref pill", () => {
    const prompt = buildCliSystemPrompt({
      agentId: "agent_1",
      workspacePath: "/tmp/workspace",
    } as Parameters<typeof buildCliSystemPrompt>[0])
    const examples = prompt.split("\n").filter((line) =>
      line.startsWith("/Alook#1234") || line.startsWith("/.dm/alice#0042"),
    )

    expect(examples).toHaveLength(6)
    for (const example of examples) {
      const children = paragraphChildren(parse(example))
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({
        type: example === "/Alook#1234" ? "serverRef" : "channelRef",
        value: example,
      })
    }
  })
})

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
    // `@bob` is not a valid handle (no #dddd), so not a mention. A bare `#0042`
    // is no longer a message ref (message-ref-upgrade.md — refs are full-path
    // now), so the whole thing is plain text.
    const children = paragraphChildren(parse("@bob check issue #0042"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.every((c) => c.type === "text")).toBe(true)
  })

  it("keeps two adjacent handles as two distinct mentions", () => {
    const children = paragraphChildren(parse("@Alice#0001 @Bob#0002"))
    const mentions = children.filter((c): c is MentionNode => c.type === "mention")
    expect(mentions.map((m) => `${m.value}#${m.discriminator}`)).toEqual(["@Alice#0001", "@Bob#0002"])
  })

  it("treats a 5+ digit run as a widened discriminator (variable-width disc), never truncated", () => {
    // Variable-width disc (A): "#00423" is now a valid 5-digit tag, so
    // "@Gus#00423" IS a mention carrying the FULL 5-digit disc — never
    // truncated to a 4-digit "0042". Prose like "issue #12345" is still safe:
    // no "@" prefix + the "#" is space-preceded, so it isn't swallowed.
    const children = paragraphChildren(parse("hi @Gus#00423"))
    const mention = children.find((c) => c.type === "mention")
    expect(mention).toMatchObject({ type: "mention", value: "@Gus", discriminator: "00423" })
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
    expect(paragraphChildren(parse("see /studio#0042/general"))[1]).toMatchObject({ type: "channelRef", value: "/studio#0042/general" })
    expect(paragraphChildren(parse("/studio#0042/general"))[0]).toMatchObject({ type: "channelRef", value: "/studio#0042/general" })
  })

  it("leaves text/studio#0042/general (no leading space) untouched", () => {
    const children = paragraphChildren(parse("text/studio#0042/general"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "text/studio#0042/general" })
  })

  it("does NOT wrap a 3+-segment docs-style path — trailing /segment fails the terminator boundary", () => {
    expect(paragraphChildren(parse("look at /api/user/123"))).toHaveLength(1)
    expect(paragraphChildren(parse("hit /docs/api/v1 first"))).toHaveLength(1)
  })

  it("still wraps a 2-segment ref followed by punctuation (period, comma, close-paren)", () => {
    const children = paragraphChildren(parse("see /studio#0042/general."))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef", "text"])
    expect(children[1]).toMatchObject({ value: "/studio#0042/general" })
    expect(children[2]).toMatchObject({ type: "text", value: "." })
  })

  it("wraps the thread form /studio#0042/general/#42", () => {
    const children = paragraphChildren(parse("see /studio#0042/general/#42"))
    expect(children[1]).toMatchObject({ type: "channelRef", value: "/studio#0042/general/#42" })
  })

  it("wraps the thread-reply form /studio#0042/general/#5#42 as a single channelRef node", () => {
    const children = paragraphChildren(parse("see /studio#0042/general/#5#42 done"))
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ type: "channelRef", value: "/studio#0042/general/#5#42" })
  })

  it("wraps the channel-message form /studio#0042/general#42 (seq glued to the channel)", () => {
    // message-ref-upgrade.md: `/server/channel#N` is a channel-MESSAGE ref. The
    // 2nd segment stops at `#` (REF_SEG excludes `#`), so `#42` falls into the
    // suffix group — the whole span is ONE channelRef (rendered as a pill with a
    // trailing `#42` cursor, resolved.seq = 42).
    const children = paragraphChildren(parse("see /studio#0042/general#42 done"))
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ type: "channelRef", value: "/studio#0042/general#42" })
  })

  it("does not wrap a mid-string path as a channelRef, and a bare #N is now plain text", () => {
    // The channelRef pass requires a leading space, so `text/.../#5#42` is NOT a
    // channelRef. And a bare `#42` is no longer a message ref (message-ref-
    // upgrade.md), so nothing pills — the whole run is plain text.
    const children = paragraphChildren(parse("text/studio#0042/general/#5#42"))
    expect(children.some((c) => c.type === "channelRef")).toBe(false)
    expect(children.every((c) => c.type === "text")).toBe(true)
  })

  it("leaves a channel-ref-shaped path inside inline code literal", () => {
    const children = paragraphChildren(parse("`/studio#0042/general`"))
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
    expect(paragraphChildren(parse("see /Gus#0042/架构"))[1]).toMatchObject({ type: "channelRef", value: "/Gus#0042/架构" })
    expect(paragraphChildren(parse("/Gus#0042/架构"))[0]).toMatchObject({ type: "channelRef", value: "/Gus#0042/架构" })
  })

  it("wraps a ref with emoji in the server segment (slugify keeps emoji, e.g. \"总部 🎉\" → \"总部-🎉\")", () => {
    const children = paragraphChildren(parse("go /总部-🎉#0042/general now"))
    expect(children.find((c) => c.type === "channelRef")).toMatchObject({ value: "/总部-🎉#0042/general" })
  })

  it("wraps a ref with accented-Latin name (café)", () => {
    expect(paragraphChildren(parse("see /studio#0042/café done"))[1]).toMatchObject({ type: "channelRef", value: "/studio#0042/café" })
  })

  it("wraps the thread form on a Unicode name — /Gus#0042/架构/#42", () => {
    expect(paragraphChildren(parse("see /Gus#0042/架构/#42"))[1]).toMatchObject({ type: "channelRef", value: "/Gus#0042/架构/#42" })
  })

  it("still terminates a Unicode ref at a trailing ASCII period — the period is not swallowed", () => {
    // Regression guard for the Unicode charset: the segment class must stay
    // disjoint from the terminator punctuation, else a greedy match eats the `.`.
    const children = paragraphChildren(parse("see /Gus#0042/架构."))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef", "text"])
    expect(children[1]).toMatchObject({ value: "/Gus#0042/架构" })
    expect(children[2]).toMatchObject({ type: "text", value: "." })
  })

  it("terminates a Unicode ref at a trailing FULL-WIDTH period 。 — the most common CJK sentence ender", () => {
    // Blair's QA flag: a Chinese sentence ends in 。, so the ref-in-a-sentence
    // shape `看 /Gus#0042/架构。` is extremely common. The full-width 。 must be a
    // terminator (in BOTH the segment-exclusion and the lookahead — the segment
    // is greedy, so lookahead-only would let it swallow the 。), else the pill
    // target becomes "架构。" and click/highlight mis-targets the real channel.
    const children = paragraphChildren(parse("看 /Gus#0042/架构。"))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef", "text"])
    expect(children[1]).toMatchObject({ value: "/Gus#0042/架构" })
    expect(children[2]).toMatchObject({ type: "text", value: "。" })
  })

  it("terminates at other full-width CJK terminators (！？ etc.)", () => {
    expect(paragraphChildren(parse("用 /Gus#0042/架构！"))[1]).toMatchObject({ value: "/Gus#0042/架构" })
    expect(paragraphChildren(parse("是 /Gus#0042/架构？好"))[1]).toMatchObject({ value: "/Gus#0042/架构" })
  })
})

describe("chatSyntaxPlugin — serverRef", () => {
  it("wraps a bare /server preceded by a space or at start-of-string", () => {
    expect(paragraphChildren(parse("check /studio#0042"))[1]).toMatchObject({ type: "serverRef", value: "/studio#0042" })
    expect(paragraphChildren(parse("/studio#0042"))[0]).toMatchObject({ type: "serverRef", value: "/studio#0042" })
  })

  it("does not double-match the first segment of a /server/channel ref", () => {
    const children = paragraphChildren(parse("see /studio#0042/general"))
    expect(children.map((c) => c.type)).toEqual(["text", "channelRef"])
    expect(children.some((c) => c.type === "serverRef")).toBe(false)
  })

  it("leaves text/studio#0042 (no leading space) untouched", () => {
    const children = paragraphChildren(parse("text/studio#0042"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "text/studio#0042" })
  })

  it("still wraps a bare ref followed by punctuation", () => {
    const children = paragraphChildren(parse("see /studio#0042."))
    expect(children.map((c) => c.type)).toEqual(["text", "serverRef", "text"])
    expect(children[1]).toMatchObject({ value: "/studio#0042" })
  })

  it("leaves a server-ref-shaped path inside inline code literal", () => {
    const children = paragraphChildren(parse("`/studio#0042`"))
    expect(children.map((c) => c.type)).toEqual(["inlineCode"])
  })

  it("does not match the invite URL's first segment", () => {
    const bare = paragraphChildren(parse("join /community/invite/abc123XYZ"))
    expect(bare).toHaveLength(1)
    expect(bare.some((c) => c.type === "serverRef")).toBe(false)
  })

  it("wraps a bare Unicode /server ref (Chinese, emoji)", () => {
    expect(paragraphChildren(parse("check /架构#0042"))[1]).toMatchObject({ type: "serverRef", value: "/架构#0042" })
    expect(paragraphChildren(parse("check /总部-🎉#0042 here"))[1]).toMatchObject({ type: "serverRef", value: "/总部-🎉#0042" })
  })

  it("terminates a Unicode /server ref at trailing punctuation (ASCII + full-width)", () => {
    const ascii = paragraphChildren(parse("check /架构#0042."))
    expect(ascii.map((c) => c.type)).toEqual(["text", "serverRef", "text"])
    expect(ascii[1]).toMatchObject({ value: "/架构#0042" })

    const cjk = paragraphChildren(parse("去 /架构#0042。"))
    expect(cjk.map((c) => c.type)).toEqual(["text", "serverRef", "text"])
    expect(cjk[1]).toMatchObject({ value: "/架构#0042" })
    expect(cjk[2]).toMatchObject({ type: "text", value: "。" })
  })
})

describe("chatSyntaxPlugin — message ref (full-path only; bare #N deprecated)", () => {
  // message-ref-upgrade.md: a message ref is ALWAYS the full path
  // `/server/channel#N` (channel message) or `/server/channel/#N#M` (thread
  // message), matched by CHANNEL_REF_RE as a channelRef. A bare `#N` is no
  // longer a ref — it renders as plain text (the deprecation).

  it("a bare #N renders as plain text (no ref node)", () => {
    for (const text of ["see #123", "#42 was fixed", "Fixed in #123.", "See #10 and #20"]) {
      const children = paragraphChildren(parse(text))
      expect(children.every((c) => c.type === "text")).toBe(true)
    }
  })

  it("a glued word#N renders as plain text (the old issue#42 pill is gone)", () => {
    const children = paragraphChildren(parse("issue#42 in GitHub"))
    expect(children.every((c) => c.type === "text")).toBe(true)
  })

  it("a channel-message ref /server/channel#N is a channelRef carrying the seq", () => {
    const children = paragraphChildren(parse("see /studio#0042/general#42 done"))
    const ref = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(ref).toMatchObject({ type: "channelRef", value: "/studio#0042/general#42" })
  })

  it("a thread-message ref /server/channel/#N#M stays a single channelRef", () => {
    const children = paragraphChildren(parse("see /studio#0042/general/#5#42 done"))
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ value: "/studio#0042/general/#5#42" })
  })

  it("a valid @name#0042 handle is still a mention, never split (mention pass runs first)", () => {
    const children = paragraphChildren(parse("@Alice#0042"))
    expect(children[0]).toMatchObject({ type: "mention", value: "@Alice", discriminator: "0042" })
  })

  it("an INVALID @name#42 (2-digit, not a mention) is now plain text (no bare-#N ref)", () => {
    const children = paragraphChildren(parse("@Alice#42"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.every((c) => c.type === "text")).toBe(true)
  })

  it("a numeric URL fragment is now plain text (no bare-#N pill — the fragile GitHub#42 case is gone)", () => {
    // The old no-leading-space MESSAGE_REF_RE turned `github.com/foo/bar#42`
    // into a pill; with full-path-only refs it's plain text. `foo/bar` is not a
    // prefix-anchored `/seg/seg` path (no leading `/`), so it isn't a channelRef
    // either. This is the disambiguation win Gus asked for.
    const children = paragraphChildren(parse("see github.com/foo/bar#42"))
    expect(children.every((c) => c.type === "text")).toBe(true)
    expect(children.some((c) => c.type === "channelRef")).toBe(false)
  })

  it("a bare #N inside inline code stays code (unchanged)", () => {
    const children = paragraphChildren(parse("`#42`"))
    expect(children.map((c) => c.type)).toEqual(["inlineCode"])
  })
})

describe("chatSyntaxPlugin — mixed", () => {
  it("handles a mix of mention, channelRef, and unrelated formatting in one message", () => {
    const children = paragraphChildren(parse("Here's the **setup**: `pnpm install` ping @Gus#0042 in /studio#0042/dev"))
    const types = children.map((c) => c.type)
    expect(types).toContain("strong")
    expect(types).toContain("inlineCode")
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus", discriminator: "0042" })
    const channelRef = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(channelRef).toMatchObject({ value: "/studio#0042/dev" })
  })

  it("handles a mention and a bare serverRef together", () => {
    const children = paragraphChildren(parse("ping @Gus#0042, see /studio#0042 for context"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus", discriminator: "0042" })
    const serverRef = children.find((c): c is ServerRefNode => c.type === "serverRef")
    expect(serverRef).toMatchObject({ value: "/studio#0042" })
  })

  it("handles mention, a full-path message ref, and a channel ref together", () => {
    const children = paragraphChildren(parse("@Alice#0001 check /studio#0042/general#42 in /studio#0042/dev"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Alice", discriminator: "0001" })
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    // Two channelRefs: the message ref (with seq) and the plain channel ref.
    expect(refs.map((r) => r.value)).toEqual(["/studio#0042/general#42", "/studio#0042/dev"])
  })
})
