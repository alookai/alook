import { describe, it, expect } from "vitest"
import { attachmentAspectRatio } from "./message"

// Reserves the correct CSS aspect-ratio box for an image attachment before
// it decodes, mirroring the pattern the embed-image `<img>` already uses.
// Falls back to a neutral "4/3" when a dimension is missing — pre-feature
// attachment rows (sent before width/height were tracked) have neither.
describe("attachmentAspectRatio", () => {
  it("returns 'width/height' when both dimensions are present", () => {
    expect(attachmentAspectRatio(1920, 1080)).toBe("1920/1080")
  })

  it("falls back to '4/3' when width is missing", () => {
    expect(attachmentAspectRatio(undefined, 1080)).toBe("4/3")
  })

  it("falls back to '4/3' when height is missing", () => {
    expect(attachmentAspectRatio(1920, undefined)).toBe("4/3")
  })

  it("falls back to '4/3' when both dimensions are missing", () => {
    expect(attachmentAspectRatio(undefined, undefined)).toBe("4/3")
  })
})
