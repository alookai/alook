import { describe, it, expect } from "vitest"
import { attachmentAspectRatio, attachmentImageFrameStyle } from "./attachment-layout"

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

describe("attachmentImageFrameStyle", () => {
  it("reserves a 300px square for a larger square image", () => {
    expect(attachmentImageFrameStyle(512, 512)).toEqual({
      width: "min(100%, 300px)",
      aspectRatio: "512/512",
    })
  })

  it("caps a portrait by height and preserves its ratio", () => {
    expect(attachmentImageFrameStyle(396, 702)).toEqual({
      width: "min(100%, 169.231px)",
      aspectRatio: "396/702",
    })
  })

  it("keeps a small known-size image at intrinsic width", () => {
    expect(attachmentImageFrameStyle(120, 80)).toEqual({
      width: "min(100%, 120px)",
      aspectRatio: "120/80",
    })
  })

  it("keeps legacy incomplete dimensions on intrinsic fallback", () => {
    expect(attachmentImageFrameStyle(undefined, 80)).toBeUndefined()
    expect(attachmentImageFrameStyle(120, undefined)).toBeUndefined()
  })
})
