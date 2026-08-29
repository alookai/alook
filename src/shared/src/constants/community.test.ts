import { describe, it, expect } from "vitest"
import * as alook from "../index"
import {
  ICON_CROP_MIN_ZOOM,
  ICON_CROP_MAX_ZOOM,
  ICON_CROP_OUTPUT_SIZE,
  MAX_ICON_SOURCE_FILE_SIZE_BYTES,
  ALLOWED_ICON_SOURCE_MIME_TYPES,
  MAX_ATTACHMENT_THUMBNAIL_EDGE_PX,
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
  MESSAGE_PREVIEW_LENGTH,
  truncateMessagePreview,
} from "./community"

describe("Community attachment thumbnail constants", () => {
  it("locks the 1024px and 512 KiB policy through both export surfaces", () => {
    expect(MAX_ATTACHMENT_THUMBNAIL_EDGE_PX).toBe(1024)
    expect(MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES).toBe(512 * 1024)
    expect(alook.MAX_ATTACHMENT_THUMBNAIL_EDGE_PX).toBe(MAX_ATTACHMENT_THUMBNAIL_EDGE_PX)
    expect(alook.MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES).toBe(MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES)
  })
})

describe("icon-crop constants", () => {
  it("ICON_CROP_MIN_ZOOM is less than ICON_CROP_MAX_ZOOM", () => {
    expect(ICON_CROP_MIN_ZOOM).toBeLessThan(ICON_CROP_MAX_ZOOM)
  })

  it("ICON_CROP_OUTPUT_SIZE is a positive number", () => {
    expect(ICON_CROP_OUTPUT_SIZE).toBeGreaterThan(0)
  })

  it("MAX_ICON_SOURCE_FILE_SIZE_BYTES is a positive number", () => {
    expect(MAX_ICON_SOURCE_FILE_SIZE_BYTES).toBeGreaterThan(0)
  })

  it("ALLOWED_ICON_SOURCE_MIME_TYPES excludes gif", () => {
    expect(ALLOWED_ICON_SOURCE_MIME_TYPES).toContain("image/png")
    expect(ALLOWED_ICON_SOURCE_MIME_TYPES).toContain("image/jpeg")
    expect(ALLOWED_ICON_SOURCE_MIME_TYPES).toContain("image/webp")
    expect(ALLOWED_ICON_SOURCE_MIME_TYPES).not.toContain("image/gif")
  })

  it("all four constants round-trip through the @alook/shared index re-export", () => {
    expect(alook.ICON_CROP_MIN_ZOOM).toBe(ICON_CROP_MIN_ZOOM)
    expect(alook.ICON_CROP_MAX_ZOOM).toBe(ICON_CROP_MAX_ZOOM)
    expect(alook.ICON_CROP_OUTPUT_SIZE).toBe(ICON_CROP_OUTPUT_SIZE)
    expect(alook.MAX_ICON_SOURCE_FILE_SIZE_BYTES).toBe(MAX_ICON_SOURCE_FILE_SIZE_BYTES)
    expect(alook.ALLOWED_ICON_SOURCE_MIME_TYPES).toEqual(ALLOWED_ICON_SOURCE_MIME_TYPES)
  })
})

describe("truncateMessagePreview", () => {
  it("keeps previews at or below the limit unchanged", () => {
    const exact = "x".repeat(MESSAGE_PREVIEW_LENGTH)
    expect(truncateMessagePreview(exact)).toBe(exact)
    expect(truncateMessagePreview("short")).toBe("short")
  })

  it("replaces the final code unit with an ellipsis only when the preview exceeds the limit", () => {
    const result = truncateMessagePreview("x".repeat(MESSAGE_PREVIEW_LENGTH + 1))
    expect(result).toBe(`${"x".repeat(MESSAGE_PREVIEW_LENGTH - 1)}…`)
    expect(result.length).toBe(MESSAGE_PREVIEW_LENGTH)
  })

  it("does not split a surrogate pair at the truncation boundary", () => {
    const result = truncateMessagePreview(`${"x".repeat(MESSAGE_PREVIEW_LENGTH - 2)}😀tail`)
    expect(result).toBe(`${"x".repeat(MESSAGE_PREVIEW_LENGTH - 2)}…`)
    expect(result.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_LENGTH)
    const beforeEllipsis = result.charCodeAt(result.length - 2)
    expect(beforeEllipsis < 0xd800 || beforeEllipsis > 0xdbff).toBe(true)
  })

  it("round-trips through the @alook/shared index re-export", () => {
    expect(alook.truncateMessagePreview).toBe(truncateMessagePreview)
  })
})
