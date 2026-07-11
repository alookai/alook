import { describe, it, expect } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Root, PhrasingContent } from "mdast"
import { chatSyntaxPlugin } from "./chat-syntax-plugin"
import type { MentionNode, ChannelRefNode } from "./chat-syntax-plugin"

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
  it("wraps a bare @name mention", () => {
    const children = paragraphChildren(parse("hi @Lindsay"))
    expect(children.map((c) => c.type)).toEqual(["text", "mention"])
    expect(children[1]).toMatchObject({ value: "@Lindsay", everyone: false })
    expect((children[1] as MentionNode).discriminator).toBeUndefined()
  })

  it("splits a @name#0042 handle into a bare mention + discriminator", () => {
    const children = paragraphChildren(parse("hi @Gus#0042"))
    expect(children[1]).toMatchObject({ type: "mention", value: "@Gus", everyone: false, discriminator: "0042" })
  })

  it("does not truncate a 5+ digit run into a false-positive discriminator", () => {
    const children = paragraphChildren(parse("hi @Gus#00423"))
    expect(children.map((c) => c.type)).toEqual(["text", "mention", "text"])
    expect(children[1]).toMatchObject({ value: "@Gus", everyone: false })
    expect(children[2]).toMatchObject({ type: "text", value: "#00423" })
  })

  it("flags @everyone", () => {
    const children = paragraphChildren(parse("cc @everyone"))
    expect(children[1]).toMatchObject({ type: "mention", value: "@everyone", everyone: true })
  })

  it("flags @here", () => {
    const children = paragraphChildren(parse("@here ping"))
    expect(children[0]).toMatchObject({ type: "mention", value: "@here", everyone: true })
  })

  it("supports Unicode names (李四, José, Ünal) — the #4 charset fix", () => {
    expect(paragraphChildren(parse("hi @李四"))[1]).toMatchObject({ value: "@李四", everyone: false })
    expect(paragraphChildren(parse("hi @José"))[1]).toMatchObject({ value: "@José", everyone: false })
    expect(paragraphChildren(parse("hi @Ünal"))[1]).toMatchObject({ value: "@Ünal", everyone: false })
  })

  it("leaves an @mention inside inline code literal", () => {
    const children = paragraphChildren(parse("use `@Lindsay` here"))
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
})

describe("chatSyntaxPlugin — mixed", () => {
  it("handles a mix of mention, channelRef, and unrelated formatting in one message", () => {
    const children = paragraphChildren(parse("Here's the **setup**: `pnpm install` ping @Gus in /studio/dev"))
    const types = children.map((c) => c.type)
    expect(types).toContain("strong")
    expect(types).toContain("inlineCode")
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus" })
    const channelRef = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(channelRef).toMatchObject({ value: "/studio/dev" })
  })
})
