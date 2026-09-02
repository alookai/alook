import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AttachmentPreviewSheet,
  readAttachmentBytes,
  readAttachmentText,
} from "./attachment-preview-sheet"
import type { FileAttachment } from "@/lib/community/models/message"
import { resetAttachmentDownloadsForTest } from "@/lib/community/attachment-download"
import { MAX_PDF_ATTACHMENT_PREVIEW_BYTES } from "@/lib/community/attachment-presentation"

const dynamicMock = vi.hoisted(() => ({
  loaders: [] as Array<() => Promise<unknown>>,
  options: [] as Array<Record<string, unknown>>,
}))

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>, options: Record<string, unknown>) => {
    dynamicMock.loaders.push(loader)
    const index = dynamicMock.options.push(options) - 1
    return index === 0
      ? ({ content, language }: { content: string; language: string | null }) => React.createElement(
          "pre",
          { "data-code-language": language ?? "plain" },
          content,
        )
      : ({ data }: { data: Uint8Array }) => React.createElement(
          "pdf-preview",
          { "data-testid": "community-pdf-preview", "data-byte-length": data.byteLength },
        )
  },
}))

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({
    title,
    description,
    footer,
    children,
    bodyTestId,
    bodyClassName,
  }: {
    title: React.ReactNode
    description?: React.ReactNode
    footer?: React.ReactNode
    children: React.ReactNode
    bodyTestId?: string
    bodyClassName?: string
  }) => React.createElement(
    "div",
    null,
    React.createElement("h2", null, title),
    description != null && React.createElement("p", null, description),
    React.createElement("main", { "data-testid": bodyTestId, className: bodyClassName }, children),
    React.createElement("footer", null, footer),
  ),
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

vi.mock("./pdf-preview", () => ({
  PdfPreview: ({ data }: { data: Uint8Array }) => React.createElement(
    "pdf-preview",
    { "data-testid": "community-pdf-preview", "data-byte-length": data.byteLength },
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
  resetAttachmentDownloadsForTest()
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

describe("readAttachmentBytes", () => {
  it("accepts the exact limit and rejects declared or streamed overflow", async () => {
    await expect(readAttachmentBytes(new Response(new Uint8Array([1, 2, 3])), 3))
      .resolves.toEqual(new Uint8Array([1, 2, 3]))
    await expect(readAttachmentBytes(new Response(new Uint8Array([1]), {
      headers: { "content-length": "4" },
    }), 3)).rejects.toThrow("too large")
    await expect(readAttachmentBytes(new Response(new Uint8Array([1, 2, 3, 4])), 3))
      .rejects.toThrow("too large")
  })

  it("reads a bodyless response through the bounded array-buffer fallback", async () => {
    const response = {
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    } as unknown as Response
    await expect(readAttachmentBytes(response, 3)).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe("AttachmentPreviewSheet", () => {
  it("keeps the syntax-preview subtree client-only with a stable loading state", async () => {
    expect(dynamicMock.options[0]?.ssr).toBe(false)
    const loading = dynamicMock.options[0]?.loading as (() => React.ReactElement) | undefined
    expect(loading).toBeTypeOf("function")
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(loading!())
    })
    const state = renderer!.root.findByProps({
      "data-testid": "community-code-preview",
    })
    expect(state.props.role).toBe("status")
    expect(state.children.join("")).toContain("Loading syntax highlighter")
  })

  it("keeps the PDF renderer client-only with a stable loading state", async () => {
    expect(dynamicMock.options[1]?.ssr).toBe(false)
    await expect(dynamicMock.loaders[1]!()).resolves.toBeTypeOf("function")
    const loading = dynamicMock.options[1]?.loading as (() => React.ReactElement) | undefined
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(loading!())
    })
    const state = renderer!.root.findByProps({
      "data-testid": "community-pdf-preview-status",
    })
    expect(state.props.role).toBe("status")
    expect(state.children.join("")).toContain("Loading PDF renderer")
  })

  it("fetches private Markdown, renders it safely, and exposes metadata/download", async () => {
    resetAttachmentDownloadsForTest()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("# Hello", { status: 200 }))
      .mockResolvedValueOnce(new Response("download bytes", { status: 200 }))
    const anchor = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    })
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() })
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
    expect(download.type).toBe("button")
    expect(download.children.join("")).toContain("Download")
    expect(download.props.className).toContain("h-11")
    expect(download.props.className).toContain("sm:h-7")
    expect(renderer!.root.findByType("footer").findByProps({
      "data-testid": "community-attachment-preview-download",
    })).toBe(download)
    expect(renderer!.root.findByType("p").children.join("")).toContain("text/markdown · 128 B")
    await act(async () => {
      download.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/attachments/a1", { credentials: "same-origin" })
    expect(anchor).toEqual(expect.objectContaining({ href: "blob:preview", download: "notes.md" }))
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-download" }).children.join(""))
      .toContain("Download started")
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

  it("keeps the exact PDF cap eligible and hands authenticated bytes to the lazy renderer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
    }))
    vi.stubGlobal("fetch", fetchMock)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file({
          name: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: MAX_PDF_ATTACHMENT_PREVIEW_BYTES,
        }),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    await flush()

    expect(fetchMock).toHaveBeenCalledWith("/attachments/a1", expect.objectContaining({
      credentials: "same-origin",
    }))
    expect(renderer!.root.findByProps({ "data-testid": "community-pdf-preview" }).props["data-byte-length"])
      .toBe(4)
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .toContain("p-0")
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .toContain("overflow-hidden")
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-download" }))
      .toBeTruthy()
  })

  it("rejects a known oversized PDF before fetch while preserving Download", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file({
          name: "large.pdf",
          contentType: "application/pdf",
          sizeBytes: MAX_PDF_ATTACHMENT_PREVIEW_BYTES + 1,
        }),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(renderer!.root.findAllByType("p").some((node) => node.children.join("").includes("too large")))
      .toBe(true)
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-download" }))
      .toBeTruthy()
  })

  it("aborts PDF acquisition when the sheet closes", async () => {
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return new Promise<Response>(() => {})
    }))
    let renderer: TestRenderer.ReactTestRenderer
    const attachment = file({ name: "report.pdf", contentType: "application/pdf" })
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment,
        open: true,
        onOpenChange: vi.fn(),
      }))
    })

    expect(requestSignal?.aborted).toBe(false)
    await act(async () => {
      renderer!.update(React.createElement(AttachmentPreviewSheet, {
        attachment,
        open: false,
        onOpenChange: vi.fn(),
      }))
    })
    expect(requestSignal?.aborted).toBe(true)
    expect(renderer!.root.findAllByProps({ "data-testid": "community-pdf-preview" }))
      .toHaveLength(0)
  })

  it("keeps Download available when the authenticated PDF request is denied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })))
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AttachmentPreviewSheet, {
        attachment: file({ name: "private.pdf", contentType: "application/pdf" }),
        open: true,
        onOpenChange: vi.fn(),
      }))
    })
    await flush()

    expect(renderer!.root.findAllByType("p").some((node) => node.children.join("").includes("403")))
      .toBe(true)
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-download" }))
      .toBeTruthy()
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
    expect(renderer!.root.findByProps({ "data-testid": "community-attachment-preview-content" }).props.className)
      .not.toContain("overflow-hidden")
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
