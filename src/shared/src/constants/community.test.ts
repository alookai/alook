import { describe, it, expect } from "vitest"
import * as alook from "../index"
import {
  ICON_CROP_MIN_ZOOM,
  ICON_CROP_MAX_ZOOM,
  ICON_CROP_OUTPUT_SIZE,
  MAX_ICON_SOURCE_FILE_SIZE_BYTES,
  ALLOWED_ICON_SOURCE_MIME_TYPES,
} from "./community"

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
