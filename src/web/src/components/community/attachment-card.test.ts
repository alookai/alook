import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { AttachmentCard } from "./attachment-card"
import type { FileAttachment } from "./_types"

function attachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    kind: "file",
    name: "notes.md",
    url: "/attachments/a1",
    contentType: "text/markdown",
    sizeBytes: 128,
    size: "128 B",
    ...overrides,
  }
}

describe("AttachmentCard", () => {
  it("opens previewable text through the shared preview handler", () => {
    const onPreview = vi.fn()
    const onDownload = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: attachment(),
        onPreview,
        onDownload,
      }))
    })
    const button = renderer!.root.findByType("button")
    expect(button.props["data-attachment-category"]).toBe("text")
    expect(button.props["aria-label"]).toBe("Preview notes.md")
    act(() => button.props.onClick())
    expect(onPreview).toHaveBeenCalledWith(attachment())
    expect(onDownload).not.toHaveBeenCalled()
  })

  it("downloads unsupported files and preserves the original filename", () => {
    const onPreview = vi.fn()
    const onDownload = vi.fn()
    const pdf = attachment({ name: "报告.pdf", contentType: "application/pdf" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: pdf,
        onPreview,
        onDownload,
      }))
    })
    const button = renderer!.root.findByType("button")
    expect(button.props["data-attachment-category"]).toBe("pdf")
    expect(button.props["aria-label"]).toBe("Download 报告.pdf")
    act(() => button.props.onClick())
    expect(onDownload).toHaveBeenCalledWith("/attachments/a1", "报告.pdf")
    expect(onPreview).not.toHaveBeenCalled()
  })
})
