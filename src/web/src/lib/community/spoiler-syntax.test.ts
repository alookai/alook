import { describe, it, expect } from "vitest"
import { fromMarkdown } from "mdast-util-from-markdown"
import type { Root, PhrasingContent } from "mdast"
import { spoilerSyntax, spoilerFromMarkdown, type SpoilerNode } from "./spoiler-syntax"

function parse(md: string): Root {
  return fromMarkdown(md, {
    extensions: [spoilerSyntax()],
    mdastExtensions: [spoilerFromMarkdown()],
  })
}

function paragraphChildren(tree: Root): PhrasingContent[] {
  const para = tree.children[0]
  if (para?.type !== "paragraph") throw new Error("expected a paragraph")
  return para.children
}

describe("spoilerSyntax", () => {
  it("produces a spoiler node for a bare ||secret||", () => {
    const children = paragraphChildren(parse("psst ||secret||"))
    expect(children.map((c) => c.type)).toEqual(["text", "spoiler"])
    const spoiler = children[1] as SpoilerNode
    expect(spoiler.children).toHaveLength(1)
    expect(spoiler.children[0]).toMatchObject({ type: "text", value: "secret" })
  })

  it("produces a spoiler node CONTAINING a nested strong node for nested formatting — the verified regression case", () => {
    // A text-node find-and-replace pass (mdast-util-find-and-replace) cannot
    // handle this: remark-parse splits this input into 3 sibling nodes
    // (text, strong, text) before any post-processing plugin runs, so the
    // two `|` markers never co-occur in one text node to match against.
    // The micromark tokenizer extension recognizes the `||` boundary during
    // tokenization instead — the same phase that recognizes `**` — so this
    // must NOT silently fail to match.
    const children = paragraphChildren(parse("hello ||I think **this** is neat|| world"))
    expect(children.map((c) => c.type)).toEqual(["text", "spoiler", "text"])
    const spoiler = children[1] as SpoilerNode
    expect(spoiler.children.map((c) => c.type)).toEqual(["text", "strong", "text"])
    const strong = spoiler.children[1]
    expect(strong).toMatchObject({ type: "strong" })
  })

  it("does not convert spoiler markers inside an inline code span", () => {
    const children = paragraphChildren(parse("use `||x||` here"))
    expect(children.map((c) => c.type)).toEqual(["text", "inlineCode", "text"])
    expect(children[1]).toMatchObject({ type: "inlineCode", value: "||x||" })
  })

  it("does not convert spoiler markers inside a fenced code block", () => {
    const tree = parse("```\n||x||\n```")
    expect(tree.children.map((c) => c.type)).toEqual(["code"])
    expect(tree.children[0]).toMatchObject({ value: "||x||" })
  })

  it("leaves an unterminated ||text (no closing pair) as literal text", () => {
    const children = paragraphChildren(parse("||text with no close"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "||text with no close" })
  })

  it("does not convert a lone single | (e.g. inside a table row) into a spoiler boundary", () => {
    const children = paragraphChildren(parse("a | b"))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ type: "text", value: "a | b" })
  })
})
