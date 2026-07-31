import { describe, it, expect } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Root, PhrasingContent } from "mdast"
import { chatSyntaxPlugin } from "./chat-syntax-plugin"
import type { MentionNode, RefTokenNode } from "./chat-syntax-plugin"

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

  it("does not truncate a 5+ digit run into a false-positive discriminator (still not a mention)", () => {
    // "#00423" is not a 4-digit tag, so "@Gus#00423" is NOT a mention. A bare
    // `#N` is no longer a message ref (message-ref-upgrade.md), so the run stays
    // plain text. The key guarantee this test protects is unchanged: it is NOT
    // parsed as a mention with a truncated discriminator.
    const children = paragraphChildren(parse("hi @Gus#00423"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.every((c) => c.type === "text")).toBe(true)
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

describe("chatSyntaxPlugin — bare paths degrade to plain text (ref/id decision B)", () => {
  // Decision B (Gener): the composer now emits an authoritative
  // `{label}(type/id)` ref token for every channel/server/message ref, and that
  // token is the ONLY thing this plugin turns into a pill. Every BARE path form
  // — `/server/channel`, bare `/server`, the channel-message `/server/channel#N`,
  // the thread `/server/channel/#N` / `/server/channel/#N#M`, and a bare `#N` —
  // is no longer recognized and renders as plain text (a stale ref in an old
  // message, or a hand-typed one, just stays literal). No `channelRef`/
  // `serverRef` node type exists anymore; the only ref node is `refToken`.

  it("a bare /server/channel stays plain text", () => {
    for (const text of ["see /studio/general", "/studio/general", "看 /Gus/架构", "go /总部-🎉/general now"]) {
      const children = paragraphChildren(parse(text))
      expect(children.every((c) => c.type === "text")).toBe(true)
    }
  })

  it("a bare /server stays plain text", () => {
    for (const text of ["check /studio", "/studio", "check /架构 here"]) {
      const children = paragraphChildren(parse(text))
      expect(children.every((c) => c.type === "text")).toBe(true)
    }
  })

  it("the bare thread / message / channel-message path forms all stay plain text", () => {
    for (const text of [
      "see /studio/general/#42",
      "see /studio/general/#5#42 done",
      "see /studio/general#42 done",
    ]) {
      const children = paragraphChildren(parse(text))
      expect(children.every((c) => c.type === "text")).toBe(true)
    }
  })

  it("a bare #N (and a glued word#N) stays plain text", () => {
    for (const text of ["see #123", "#42 was fixed", "issue#42 in GitHub", "see github.com/foo/bar#42"]) {
      const children = paragraphChildren(parse(text))
      expect(children.every((c) => c.type === "text")).toBe(true)
    }
  })

  it("a valid @name#0042 handle is still a mention (mention pass is unaffected)", () => {
    const children = paragraphChildren(parse("@Alice#0042"))
    expect(children[0]).toMatchObject({ type: "mention", value: "@Alice", discriminator: "0042" })
  })

  it("an INVALID @name#42 (2-digit, not a mention) is plain text", () => {
    const children = paragraphChildren(parse("@Alice#42"))
    expect(children.every((c) => c.type === "text")).toBe(true)
  })

  it("a path-shaped span inside inline code stays code (unchanged)", () => {
    expect(paragraphChildren(parse("`/studio/general`")).map((c) => c.type)).toEqual(["inlineCode"])
    expect(paragraphChildren(parse("`#42`")).map((c) => c.type)).toEqual(["inlineCode"])
  })
})

describe("chatSyntaxPlugin — mixed", () => {
  it("keeps a mention live while a bare path alongside it stays plain text", () => {
    const children = paragraphChildren(parse("Here's the **setup**: `pnpm install` ping @Gus#0042 in /studio/dev"))
    const types = children.map((c) => c.type)
    expect(types).toContain("strong")
    expect(types).toContain("inlineCode")
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus", discriminator: "0042" })
    // The bare `/studio/dev` no longer pills — it rides along in a text node.
    expect(children.some((c) => c.type === "refToken")).toBe(false)
    expect(children.some((c) => c.type === ("channelRef" as string))).toBe(false)
  })

  it("keeps a mention and a ref token live together while a bare path stays text", () => {
    const children = paragraphChildren(parse("@Alice#0001 check {/studio/general#42}(message/m_x) in /studio/dev"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Alice", discriminator: "0001" })
    const tok = children.find((c): c is RefTokenNode => c.type === "refToken")
    expect(tok).toMatchObject({ refType: "message", id: "m_x", label: "/studio/general#42" })
    // The trailing bare `/studio/dev` is plain text under B.
    expect(children.filter((c) => c.type === "refToken")).toHaveLength(1)
  })
})

describe("chatSyntaxPlugin — refToken {label}(type/id) (ref/id §3)", () => {
  it("parses each type into a refToken node with unescaped label + type + id", () => {
    const ch = paragraphChildren(parse("see {/Alook/general}(channel/K9f_rnJk)"))
      .find((c): c is RefTokenNode => c.type === "refToken")
    expect(ch).toMatchObject({ type: "refToken", label: "/Alook/general", refType: "channel", id: "K9f_rnJk" })
    const msg = paragraphChildren(parse("{/Alook/general#42}(message/m_ab)"))
      .find((c): c is RefTokenNode => c.type === "refToken")
    expect(msg).toMatchObject({ refType: "message", id: "m_ab", label: "/Alook/general#42" })
    const srv = paragraphChildren(parse("{/Alook}(server/srv_x)"))
      .find((c): c is RefTokenNode => c.type === "refToken")
    expect(srv).toMatchObject({ refType: "server", id: "srv_x", label: "/Alook" })
  })

  it("a raw } closes the label (no escape layer) — a sanitized label parses cleanly", () => {
    // Producers sanitize `}`→`_` (formatRefToken), so a well-formed token never
    // carries a raw `}` in its label; the sanitized form parses normally.
    const tok = paragraphChildren(parse("{/Alook/plan_b}(channel/c1)"))
      .find((c): c is RefTokenNode => c.type === "refToken")
    expect(tok).toMatchObject({ label: "/Alook/plan_b", refType: "channel", id: "c1" })
  })

  it("pills the token but leaves a bare /server/channel beside it as plain text (decision B — single path)", () => {
    const children = paragraphChildren(parse("old {/Alook/general}(channel/c1) new /Alook/dev"))
    // Exactly one ref node — the token. The bare `/Alook/dev` no longer pills.
    expect(children.filter((c) => c.type === "refToken")).toHaveLength(1)
    expect(children.some((c) => c.type === ("channelRef" as string))).toBe(false)
    const tail = children[children.length - 1]
    expect(tail?.type).toBe("text")
    expect((tail as { value: string }).value).toContain("/Alook/dev")
  })

  it("a non-whitelisted type stays plain text (no node)", () => {
    const children = paragraphChildren(parse("{/x}(user/u_1)"))
    expect(children.some((c) => c.type === "refToken")).toBe(false)
  })

  it("a token inside a code span stays literal (IGNORE list)", () => {
    const children = paragraphChildren(parse("`{/Alook/general}(channel/c1)`"))
    expect(children.some((c) => c.type === "refToken")).toBe(false)
    expect(children[0]?.type).toBe("inlineCode")
  })
})
