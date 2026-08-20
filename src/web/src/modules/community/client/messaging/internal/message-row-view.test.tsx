import { describe, it, expect } from "vitest"
import { attachmentAspectRatio } from "@/components/community/messages/attachment-layout"
import { TypingIndicator } from "../typing-indicator"

// Reserves the correct CSS aspect-ratio box for an image attachment before
// it decodes, mirroring the pattern the embed-image `<img>` already uses.
// Falls back to intrinsic sizing when a dimension is missing — pre-feature
// attachment rows (sent before width/height were tracked) have neither.
describe("attachmentAspectRatio", () => {
  it("returns 'width/height' when both dimensions are present", () => {
    expect(attachmentAspectRatio(1920, 1080)).toBe("1920/1080")
  })

  it("falls back to 'auto' when width is missing", () => {
    expect(attachmentAspectRatio(undefined, 1080)).toBe("auto")
  })

  it("falls back to 'auto' when height is missing", () => {
    expect(attachmentAspectRatio(1920, undefined)).toBe("auto")
  })

  it("falls back to 'auto' when both dimensions are missing", () => {
    expect(attachmentAspectRatio(undefined, undefined)).toBe("auto")
  })
})

describe("TypingIndicator", () => {
  it.each([
    { names: [] as string[], visible: false },
    { names: ["Alice"], visible: true },
    { names: ["Alice", "Bob"], visible: true },
    { names: ["Alice", "Bob", "Cora", "Drew"], visible: true },
  ])("renders every label cardinality for $names", ({ names, visible }) => {
    const element = TypingIndicator({ names })
    expect(element.props["data-testid"] !== undefined).toBe(visible)
  })
})
