import { describe, expect, it } from "vitest"
import {
  formatAttachmentSize,
  resolveAttachmentPresentation,
} from "./attachment-presentation"

describe("resolveAttachmentPresentation", () => {
  it.each([
    ["report.pdf", "application/pdf", "pdf", null],
    ["sheet.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "spreadsheet", null],
    ["slides.bin", "application/vnd.ms-powerpoint", "presentation", null],
    ["voice.bin", "audio/mpeg", "audio", null],
    ["clip.bin", "video/mp4", "video", null],
    ["data.bin", "application/json; charset=utf-8", "code", "code"],
    ["readme.bin", "text/markdown", "text", "markdown"],
    ["notes.bin", "text/plain", "text", "text"],
  ])("uses MIME for %s", (filename, contentType, category, previewKind) => {
    expect(resolveAttachmentPresentation(filename, contentType)).toEqual({ category, previewKind })
  })

  it.each([
    ["README.md", undefined, "text", "markdown"],
    ["config.json", "application/octet-stream", "code", "code"],
    [".env.local", "", "code", "code"],
    ["deck.pptx", undefined, "presentation", null],
    ["bundle.zip", "binary/octet-stream", "archive", null],
  ])("falls back to the extension for generic MIME: %s", (filename, contentType, category, previewKind) => {
    expect(resolveAttachmentPresentation(filename, contentType)).toEqual({ category, previewKind })
  })

  it("does not execute active or unknown content", () => {
    expect(resolveAttachmentPresentation("page.html", "text/html")).toEqual({ category: "unknown", previewKind: null })
    expect(resolveAttachmentPresentation("vector.svg", "image/svg+xml")).toEqual({ category: "image", previewKind: null })
    expect(resolveAttachmentPresentation("payload.bin", "application/x-custom")).toEqual({ category: "unknown", previewKind: null })
  })
})

describe("formatAttachmentSize", () => {
  it("formats bytes with stable binary units", () => {
    expect(formatAttachmentSize(0)).toBe("0 B")
    expect(formatAttachmentSize(1536)).toBe("1.5 KB")
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2.0 MB")
  })
})
