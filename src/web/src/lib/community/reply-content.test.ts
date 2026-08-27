import { describe, expect, it } from "vitest"
import { canonicalizeReplyContent, displayReplyContent } from "./reply-content"

describe("reply content", () => {
  const alice = { authorName: "Alice Smith" }

  it("adds one exact author prefix to plain text and Markdown blocks", () => {
    expect(canonicalizeReplyContent("hello", alice)).toBe("@Alice Smith\nhello")
    expect(canonicalizeReplyContent("> quote\n\n- one", alice)).toBe(
      "@Alice Smith\n> quote\n\n- one",
    )
  })

  it("keeps an existing same-author mention only at an exact boundary", () => {
    expect(canonicalizeReplyContent("@Alice Smith\nhello", alice)).toBe(
      "@Alice Smith\nhello",
    )
    expect(canonicalizeReplyContent("@Alice Smith hello", alice)).toBe(
      "@Alice Smith hello",
    )
    expect(canonicalizeReplyContent("@Alice Smith", alice)).toBe("@Alice Smith")
    expect(canonicalizeReplyContent("@Alice Smithers hello", alice)).toBe(
      "@Alice Smith\n@Alice Smithers hello",
    )
    expect(canonicalizeReplyContent("@Bob hello", alice)).toBe(
      "@Alice Smith\n@Bob hello",
    )
  })

  it("canonicalizes attachment-only reply content", () => {
    expect(canonicalizeReplyContent("", alice)).toBe("@Alice Smith\n")
  })

  it("strips one matching prefix and one logical boundary", () => {
    expect(displayReplyContent("@Alice Smith\nhello", alice)).toBe("hello")
    expect(displayReplyContent("@Alice Smith\r\nhello", alice)).toBe("hello")
    expect(displayReplyContent("@Alice Smith  hello", alice)).toBe(" hello")
    expect(displayReplyContent("@Alice Smith\thello", alice)).toBe("hello")
    expect(displayReplyContent("@Alice Smith", alice)).toBe("")
  })

  it("leaves legacy, different-author, longer-name, and non-reply content unchanged", () => {
    expect(displayReplyContent("legacy", alice)).toBe("legacy")
    expect(displayReplyContent("@Bob\nhello", alice)).toBe("@Bob\nhello")
    expect(displayReplyContent("@Alice Smithers\nhello", alice)).toBe(
      "@Alice Smithers\nhello",
    )
    expect(displayReplyContent("@Alice Smith\nhello", undefined)).toBe(
      "@Alice Smith\nhello",
    )
  })

  it("does not manufacture a bare mention for a missing author name", () => {
    expect(canonicalizeReplyContent("hello", { authorName: "" })).toBe("hello")
    expect(displayReplyContent("@\nhello", { authorName: "" })).toBe("@\nhello")
  })
})
