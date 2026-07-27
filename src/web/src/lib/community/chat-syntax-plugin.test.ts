import { describe, it, expect } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Root, PhrasingContent } from "mdast"
import { chatSyntaxPlugin } from "./chat-syntax-plugin"
import type { MentionNode, ChannelRefNode, MessageRefNode } from "./chat-syntax-plugin"

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

  it("does not truncate a 5+ digit run into a false-positive discriminator", () => {
    // "#00423" is not a 4-digit tag, and a bare "@Gus" is no longer a mention,
    // so the whole token stays plain text.
    const children = paragraphChildren(parse("hi @Gus#00423"))
    expect(children.some((c) => c.type === "mention")).toBe(false)
    expect(children.map((c) => c.type)).toEqual(["text"])
  })

  it("flags @everyone", () => {
    const children = paragraphChildren(parse("cc @everyone"))
    expect(children[1]).toMatchObject({ type: "mention", value: "@everyone", everyone: true })
  })

  it("flags @here", () => {
    const children = paragraphChildren(parse("@here ping"))
    expect(children[0]).toMatchObject({ type: "mention", value: "@here", everyone: true })
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
  it("wraps a `<#serverId:channelId>` token", () => {
    expect(paragraphChildren(parse("see <#srv_1:chn_1>"))[1]).toMatchObject({ type: "channelRef", value: "<#srv_1:chn_1>" })
    expect(paragraphChildren(parse("<#srv_1:chn_1>"))[0]).toMatchObject({ type: "channelRef", value: "<#srv_1:chn_1>" })
  })

  it("wraps a token that appears mid-word — the `<#…>` delimiters are unambiguous", () => {
    const children = paragraphChildren(parse("text<#srv_1:chn_1>"))
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ value: "<#srv_1:chn_1>" })
  })

  it("wraps a token followed by punctuation", () => {
    const children = paragraphChildren(parse("see <#srv_1:chn_1>."))
    const refs = children.filter((c): c is ChannelRefNode => c.type === "channelRef")
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ value: "<#srv_1:chn_1>" })
  })

  it("retires the `/server/channel` grammar — an old ref renders as plain text, not a pill", () => {
    const children = paragraphChildren(parse("see /studio/general"))
    expect(children.some((c) => c.type === "channelRef")).toBe(false)
    expect(children.map((c) => c.type)).toEqual(["text"])
  })

  it("does not wrap a bare `/server` — server refs are retired", () => {
    const children = paragraphChildren(parse("check /studio"))
    expect(children.map((c) => c.type)).toEqual(["text"])
  })

  it("leaves a channel-ref token inside inline code literal", () => {
    const children = paragraphChildren(parse("`<#srv_1:chn_1>`"))
    expect(children.map((c) => c.type)).toEqual(["inlineCode"])
  })

  it("does not match a token missing a segment", () => {
    expect(paragraphChildren(parse("see <#srv_1>")).some((c) => c.type === "channelRef")).toBe(false)
    expect(paragraphChildren(parse("see <#srv_1:>")).some((c) => c.type === "channelRef")).toBe(false)
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

  it("does NOT parse text#NUMBER (no leading space) as messageRef", () => {
    const children = paragraphChildren(parse("issue#42 in GitHub"))
    expect(children.some((c) => c.type === "messageRef")).toBe(false)
    expect(children.map((c) => c.type)).toEqual(["text"])
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
})

describe("chatSyntaxPlugin — mixed", () => {
  it("handles a mix of mention, channelRef, and unrelated formatting in one message", () => {
    const children = paragraphChildren(parse("Here's the **setup**: `pnpm install` ping @Gus#0042 in <#srv_1:chn_dev>"))
    const types = children.map((c) => c.type)
    expect(types).toContain("strong")
    expect(types).toContain("inlineCode")
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Gus", discriminator: "0042" })
    const channelRef = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(channelRef).toMatchObject({ value: "<#srv_1:chn_dev>" })
  })

  it("handles mention, message ref, and channel ref together", () => {
    const children = paragraphChildren(parse("@Alice#0001 check #42 in <#srv_1:chn_general>"))
    const mention = children.find((c): c is MentionNode => c.type === "mention")
    expect(mention).toMatchObject({ value: "@Alice", discriminator: "0001" })
    const messageRef = children.find((c): c is MessageRefNode => c.type === "messageRef")
    expect(messageRef).toMatchObject({ value: "#42" })
    const channelRef = children.find((c): c is ChannelRefNode => c.type === "channelRef")
    expect(channelRef).toMatchObject({ value: "<#srv_1:chn_general>" })
  })
})
