import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AttachmentCard } from "./attachment-card"
import type { FileAttachment } from "@/lib/community/models/message"
import { resetAttachmentDownloadsForTest } from "@/lib/community/attachment-download"

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
  beforeEach(() => resetAttachmentDownloadsForTest())
  afterEach(() => {
    resetAttachmentDownloadsForTest()
    vi.unstubAllGlobals()
  })

  it("opens previewable text through the shared preview handler", () => {
    const onPreview = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: attachment(),
        onPreview,
      }))
    })
    const button = renderer!.root.findByType("button")
    expect(button.props["data-attachment-category"]).toBe("text")
    expect(button.props["aria-label"]).toBe("Preview notes.md")
    act(() => button.props.onClick())
    expect(onPreview).toHaveBeenCalledWith(attachment())
  })

  it("downloads unsupported files through the shared owner and preserves the original filename", async () => {
    const onPreview = vi.fn()
    const anchor = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bytes")))
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    })
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:file"), revokeObjectURL: vi.fn() })
    const archive = attachment({ name: "报告.zip", contentType: "application/zip" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: archive,
        onPreview,
      }))
    })
    const button = renderer!.root.findByType("button")
    expect(button.props["data-attachment-category"]).toBe("archive")
    expect(button.props["aria-label"]).toBe("Download 报告.zip")
    await act(async () => {
      button.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledWith("/attachments/a1", { credentials: "same-origin" })
    expect(anchor).toEqual(expect.objectContaining({ href: "blob:file", download: "报告.zip" }))
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(onPreview).not.toHaveBeenCalled()
    expect(renderer!.root.findByProps({ role: "status" }).children).toEqual(["Download started"])
  })

  it("opens a PDF through the shared preview handler", () => {
    const onPreview = vi.fn()
    const pdf = attachment({ name: "报告.pdf", contentType: "application/pdf" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: pdf,
        onPreview,
      }))
    })

    const button = renderer!.root.findByType("button")
    expect(button.props["data-attachment-category"]).toBe("pdf")
    expect(button.props["aria-label"]).toBe("Preview 报告.pdf")
    act(() => button.props.onClick())
    expect(onPreview).toHaveBeenCalledWith(pdf)
  })

  it.each([
    ["source.ts", "application/octet-stream", "code"],
    ["unsafe.svg", "image/svg+xml", "code"],
  ])("opens %s through the source preview instead of download", (name, contentType, category) => {
    const onPreview = vi.fn()
    const source = attachment({ name, contentType })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: source,
        onPreview,
      }))
    })
    const button = renderer!.root.findByType("button")
    expect(button.props["data-attachment-category"]).toBe(category)
    expect(button.props["aria-label"]).toBe(`Preview ${name}`)
    act(() => button.props.onClick())
    expect(onPreview).toHaveBeenCalledWith(source)
  })

  it.each([
    ["voice.mp3", "audio/mpeg", "audio"],
    ["clip.webm", "application/octet-stream", "video"],
  ])("delegates %s to the shared %s media block", (name, contentType, mediaKind) => {
    const file = attachment({ name, contentType })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: file,
      }))
    })

    expect(renderer!.root.findByProps({ "data-testid": `community-media-block-${name}` }).props["data-media-kind"])
      .toBe(mediaKind)
    expect(renderer!.root.findAllByProps({ "data-testid": `community-attachment-card-${name}` }))
      .toHaveLength(0)
  })

  it("does not let a media-looking filename override a specific non-media MIME", () => {
    const pdf = attachment({ name: "document.mp4", contentType: "application/pdf" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(AttachmentCard, {
        attachment: pdf,
      }))
    })

    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-card-document.mp4" }).props["data-attachment-category"])
      .toBe("pdf")
    expect(renderer!.root.findAllByProps({ "data-testid": "community-media-block-document.mp4" }))
      .toHaveLength(0)
  })

  it("shares one in-flight state and operation across two rendered surfaces", async () => {
    let resolveBlob!: (blob: Blob) => void
    const blob = vi.fn(() => new Promise<Blob>((resolve) => { resolveBlob = resolve }))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob })
    const anchor = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    })
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:file"), revokeObjectURL: vi.fn() })
    const pdf = attachment({ name: "report.pdf", contentType: "application/pdf" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(React.Fragment, null,
        React.createElement(AttachmentCard, { attachment: pdf }),
        React.createElement(AttachmentCard, { attachment: pdf }),
      ))
    })

    const buttons = renderer!.root.findAllByType("button")
    act(() => {
      buttons[0]!.props.onClick()
      buttons[1]!.props.onClick()
    })
    expect(renderer!.root.findAllByProps({ role: "status" }).map((node) => node.children.join("")))
      .toEqual(["Downloading…", "Downloading…"])
    expect(renderer!.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(blob).toHaveBeenCalledOnce())
    resolveBlob(new Blob(["complete"]))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByProps({ role: "status" }).map((node) => node.children.join("")))
      .toEqual(["Download started", "Download started"])
  })
})
