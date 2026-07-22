import { describe, it, expect } from "vitest"
import { splitPlainTextToBlocks, planPastedBlocks } from "./paste-plain-text"

describe("splitPlainTextToBlocks", () => {
  it("splits on a blank line into separate blocks", () => {
    expect(splitPlainTextToBlocks("para one\n\npara two")).toEqual(["para one", "para two"])
  })

  it("keeps a single newline inside one block (not a paragraph break)", () => {
    expect(splitPlainTextToBlocks("line one\nline two")).toEqual(["line one\nline two"])
  })

  it("treats 3+ newlines as one paragraph break, not empty blocks", () => {
    expect(splitPlainTextToBlocks("a\n\n\nb")).toEqual(["a", "b"])
  })

  it("trims leading/trailing blank lines so there are no empty edge blocks", () => {
    expect(splitPlainTextToBlocks("\n\nmiddle\n\n")).toEqual(["middle"])
  })

  it("normalizes CRLF", () => {
    expect(splitPlainTextToBlocks("a\r\n\r\nb")).toEqual(["a", "b"])
  })

  it("returns an empty array for whitespace-only text", () => {
    expect(splitPlainTextToBlocks("\n\n\n")).toEqual([])
  })
})

describe("planPastedBlocks", () => {
  it("returns one block per blank-line-separated paragraph", () => {
    expect(planPastedBlocks("para one\n\npara two")).toEqual([["para one"], ["para two"]])
  })

  it("splits single newlines into hard-break lines within one block", () => {
    expect(planPastedBlocks("line one\nline two\nline three")).toEqual([
      ["line one", "line two", "line three"],
    ])
  })

  it("preserves both levels together (paragraphs with internal line breaks)", () => {
    // A title line + body line in one paragraph, then a separate paragraph —
    // mirrors the reported agent-answer paste (blank line between sections,
    // single newline between a heading and its text).
    expect(planPastedBlocks("**title**\nbody line\n\nnext para")).toEqual([
      ["**title**", "body line"],
      ["next para"],
    ])
  })

  it("returns an empty plan for whitespace-only text", () => {
    expect(planPastedBlocks("\n\n")).toEqual([])
  })
})
