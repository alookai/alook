import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AttachmentPreviewSheet, readAttachmentText } from "./attachment-preview-sheet"
import type { FileAttachment } from "@/lib/community/models/message"

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  CommunitySheetHeader: ({ children, ...props }: React.ComponentProps<"header">) => React.createElement("header", props, children),
  CommunitySheetTitle: ({ children, ...props }: React.ComponentProps<"h2">) => React.createElement("h2", props, children),
  CommunitySheetDescription: ({ children, ...props }: React.ComponentProps<"p">) => React.createElement("p", props, children),
  CommunitySheetBody: ({ children, ...props }: React.ComponentProps<"main">) => React.createElement("main", props, children),
}))

vi.mock("@/components/ui/sheet-resize-handle", () => ({
  useSheetResize: () => ({
    width: 520,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  }),
  SheetResizeHandle: () => null,
}))

vi.mock("./message-body", () => ({
  MessageBody: ({ text }: { text: string }) => React.createElement("article", { "data-markdown": true }, text),
}))

vi.mock("./code-preview", () => ({
  CodePreview: ({ content, language }: { content: string; language: string | null }) => React.createElement(
    "pre",
    { "data-code-language": language ?? "plain" },
    content,
  ),
}))

function file(overrides: Partial<FileAttachment> = {}): FileAttachment {
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("readAttachmentText", () => {
  it("rejects denied and oversized responses", async () => {
    await expect(readAttachmentText(new Response("no", { status: 404 }))).rejects.toThrow("404")
    await expect(readAttachmentText(new Response("large", {
      headers: { "content-length": String(1024 * 1024 + 1) },
    }))).rejects.toThrow("too large")
  })

  it("limits a streamed response even without content-length", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]))
    await expect(readAttachmentText(response, 3)).rejects.toThrow("too large")
  })
})

describe("AttachmentPreviewSheet", () => {
  it("fetches private Markdown, renders it safely, and exposes metadata/download", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("# Hello", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file(),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledWith("/attachments/a1", expect.objectContaining({ credentials: "same-origin" }))
    expect(renderer!.root.findByProps({ "data-markdown": true }).children).toEqual(["# Hello"])
    const download = renderer!.root.findByProps({ "data-testid": "community-attachment-preview-download" })
    expect(download.props.href).toBe("/attachments/a1")
    expect(download.props.download).toBe("notes.md")
    expect(renderer!.root.findByType("p").children.join("")).toContain("text/markdown · 128 B")
  })

  it("aborts the old request on switch and never paints its stale result", async () => {
    const requests: Array<{
      resolve: (response: Response) => void
      signal: AbortSignal
    }> = []
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ resolve, signal: init.signal as AbortSignal })
    })))
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file(),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    expect(requests).toHaveLength(1)

    await act(async () => {
      renderer!.update(React.createElement(AttachmentPreviewSheet, {
        attachment: file({ name: "second.txt", url: "/attachments/a2", contentType: "text/plain" }),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(requests).toHaveLength(2)

    requests[1]!.resolve(new Response("second", { status: 200 }))
    await flush()
    expect(renderer!.root.findAllByType("pre")[0]?.children).toEqual(["second"])

    requests[0]!.resolve(new Response("stale", { status: 200 }))
    await flush()
    expect(renderer!.root.findAllByType("pre")[0]?.children).toEqual(["second"])
  })

  it("passes the resolved source language to CodePreview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("const answer = 42", { status: 200 })))
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file({ name: "answer.ts", contentType: "application/octet-stream" }),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    await flush()
    const preview = renderer!.root.findByProps({ "data-code-language": "typescript" })
    expect(preview.children).toEqual(["const answer = 42"])
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .toContain("p-0")
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .toContain("sm:p-0")
  })

  it("keeps the existing SheetBody spacing for Markdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Hello", { status: 200 })))
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file(),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    await flush()

    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .not.toContain("p-0")
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .not.toContain("sm:p-0")
  })

  it("keeps the existing one MiB ceiling for code", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file({
          name: "large.ts",
          contentType: "application/octet-stream",
          sizeBytes: 1024 * 1024 + 1,
        }),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(renderer!.root.findAllByType("p").some((node) => node.children.join("").includes("too large"))).toBe(true)
  })
})
