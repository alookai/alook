import React, { type ReactElement } from "react"
import { act, fireEvent, render as rtlRender } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AttachmentCard } from "./attachment-card"
import type { FileAttachment } from "@/lib/community/models/message"
import { resetAttachmentDownloadsForTest } from "@/lib/community/attachment-download"

const rtlContainer = document.createElement("div")
function render(element: ReactElement) {
  return rtlRender(element, { container: rtlContainer, baseElement: rtlContainer })
}

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
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(AttachmentCard, {
        attachment: attachment(),
        onPreview,
      }))
    })
    const button = renderer!.getByRole("button")
    expect(button).toHaveAttribute("data-attachment-category", "text")
    expect(button).toHaveAttribute("aria-label", "Preview notes.md")
    fireEvent.click(button)
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
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(AttachmentCard, {
        attachment: archive,
        onPreview,
      }))
    })
    const button = renderer!.getByRole("button")
    expect(button).toHaveAttribute("data-attachment-category", "archive")
    expect(button).toHaveAttribute("aria-label", "Download 报告.zip")
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledWith("/attachments/a1", { credentials: "same-origin" })
    expect(anchor).toEqual(expect.objectContaining({ href: "blob:file", download: "报告.zip" }))
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(onPreview).not.toHaveBeenCalled()
    expect(renderer!.getByRole("status")).toHaveTextContent("Download started")
  })

  it("opens a PDF through the shared preview handler", () => {
    const onPreview = vi.fn()
    const pdf = attachment({ name: "报告.pdf", contentType: "application/pdf" })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(AttachmentCard, {
        attachment: pdf,
        onPreview,
      }))
    })

    const button = renderer!.getByRole("button")
    expect(button).toHaveAttribute("data-attachment-category", "pdf")
    expect(button).toHaveAttribute("aria-label", "Preview 报告.pdf")
    fireEvent.click(button)
    expect(onPreview).toHaveBeenCalledWith(pdf)
  })

  it.each([
    ["source.ts", "application/octet-stream", "code"],
    ["unsafe.svg", "image/svg+xml", "code"],
  ])("opens %s through the source preview instead of download", (name, contentType, category) => {
    const onPreview = vi.fn()
    const source = attachment({ name, contentType })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(AttachmentCard, {
        attachment: source,
        onPreview,
      }))
    })
    const button = renderer!.getByRole("button")
    expect(button).toHaveAttribute("data-attachment-category", category)
    expect(button).toHaveAttribute("aria-label", `Preview ${name}`)
    fireEvent.click(button)
    expect(onPreview).toHaveBeenCalledWith(source)
  })

  it.each([
    ["voice.mp3", "audio/mpeg", "audio"],
    ["clip.webm", "application/octet-stream", "video"],
  ])("delegates %s to the shared %s media block", (name, contentType, mediaKind) => {
    const file = attachment({ name, contentType })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(AttachmentCard, {
        attachment: file,
      }))
    })

    expect(renderer!.getByTestId(`community-media-block-${name}`))
      .toHaveAttribute("data-media-kind", mediaKind)
    expect(renderer!.queryAllByTestId(`community-attachment-card-${name}`)).toHaveLength(0)
  })

  it("does not let a media-looking filename override a specific non-media MIME", () => {
    const pdf = attachment({ name: "document.mp4", contentType: "application/pdf" })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(AttachmentCard, {
        attachment: pdf,
      }))
    })

    expect(renderer!.getByTestId("community-attachment-card-document.mp4"))
      .toHaveAttribute("data-attachment-category", "pdf")
    expect(renderer!.queryAllByTestId("community-media-block-document.mp4")).toHaveLength(0)
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
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(React.Fragment, null,
        React.createElement(AttachmentCard, { attachment: pdf }),
        React.createElement(AttachmentCard, { attachment: pdf }),
      ))
    })

    const buttons = renderer!.getAllByRole("button")
    act(() => {
      fireEvent.click(buttons[0]!)
      fireEvent.click(buttons[1]!)
    })
    expect(renderer!.getAllByRole("status").map((node) => node.textContent))
      .toEqual(["Downloading…", "Downloading…"])
    expect(renderer!.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled))
      .toBe(true)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(blob).toHaveBeenCalledOnce())
    resolveBlob(new Blob(["complete"]))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(renderer!.getAllByRole("status").map((node) => node.textContent))
      .toEqual(["Download started", "Download started"])
  })
})
