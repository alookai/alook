import { describe, expect, it } from "vitest"
import { extractLinkPreviewUrl } from "./link-preview"

describe("extractLinkPreviewUrl", () => {
  it("selects the first eligible URL and strips fragments", () => {
    expect(extractLinkPreviewUrl(
      "first https://example.com/path#section then https://example.org/later",
    )).toBe("https://example.com/path")
  })

  it("keeps prose punctuation outside the selected URL", () => {
    expect(extractLinkPreviewUrl("See (https://github.com/alookai/alook/pull/1)."))
      .toBe("https://github.com/alookai/alook/pull/1")
  })

  it("skips invite action-card URLs and selects the next ordinary link", () => {
    expect(extractLinkPreviewUrl(
      "https://alook.ai/c/invite/abcdef https://x.com/alook/status/123",
    )).toBe("https://x.com/alook/status/123")
  })

  it("returns null when the message has no eligible public-web URL", () => {
    expect(extractLinkPreviewUrl("no link here /c/invite/abcdef ftp://example.com"))
      .toBeNull()
  })
})
