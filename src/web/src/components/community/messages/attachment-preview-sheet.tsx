"use client"

import { useQuery } from "@tanstack/react-query"
import { applicationKey, assertApplicationOwner, captureApplicationOwner, useApplicationOwner } from "@/lib/application-owner"
import dynamic from "next/dynamic"
import { CircleCheck, Download, Loader2, RefreshCw } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { cn } from "@/lib/utils"
import { MessageBody } from "./message-body"
import type { FileAttachment } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  formatAttachmentSize,
  MAX_PDF_ATTACHMENT_PREVIEW_BYTES,
  MAX_TEXT_ATTACHMENT_PREVIEW_BYTES,
  resolveAttachmentPresentation,
} from "@/lib/community/attachment-presentation"
import {
  attachmentDownloadStatusText,
  useAttachmentDownload,
} from "@/lib/community/attachment-download"

const CodePreview = dynamic(
  () => import("./code-preview").then((module) => module.CodePreview),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid={tid.codePreview}
        role="status"
        className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        Loading syntax highlighter…
      </div>
    ),
  },
)

const PdfPreview = dynamic(
  () => import("./pdf-preview").then((module) => module.PdfPreview),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid={tid.pdfPreviewStatus}
        role="status"
        className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        Loading PDF renderer…
      </div>
    ),
  },
)

type PreviewState =
  | { status: "idle" | "loading"; content: null; error: null }
  | { status: "ready"; kind: "text"; content: string; error: null }
  | { status: "ready"; kind: "pdf"; content: Uint8Array<ArrayBuffer>; error: null }
  | { status: "error"; content: null; error: string }

const IDLE_STATE: PreviewState = { status: "idle", content: null, error: null }

function AttachmentPreviewDownload({ attachment }: { attachment: FileAttachment }) {
  const download = useAttachmentDownload(attachment)
  const statusText = attachmentDownloadStatusText(download.state)
  const Icon = download.state.status === "downloading"
    ? Loader2
    : (download.state.status === "saved" || download.state.status === "started")
      ? CircleCheck
      : download.state.status === "error"
        ? RefreshCw
        : Download

  return (
    <button
      type="button"
      data-testid={tid.attachmentPreviewDownload}
      onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}
      aria-busy={download.state.status === "downloading"}
      className={buttonVariants({
        variant: "outline",
        size: "sm",
        className: "h-11 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground sm:h-7",
      })}
    >
      <Icon className={`size-3.5 ${download.state.status === "downloading" ? "animate-spin motion-reduce:animate-none" : ""}`} />
      {download.state.status === "downloading" ? "Cancel download" : statusText ?? "Download"}
    </button>
  )
}

export async function readAttachmentText(
  response: Response,
  maxBytes = MAX_TEXT_ATTACHMENT_PREVIEW_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await readAttachmentBytes(response, maxBytes, signal))
}

export async function readAttachmentBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw new Error(`Couldn’t load this attachment (${response.status})`)
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("This file is too large to preview")
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (bytes.byteLength > maxBytes) throw new Error("This file is too large to preview")
    return bytes
  }

  const reader = response.body.getReader()
  let byteLength = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new Error("This file is too large to preview")
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function AttachmentPreviewSheet({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: FileAttachment | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const owner = useApplicationOwner()
  const selected = attachment
  const presentation = selected ? resolveAttachmentPresentation(selected.name, selected.contentType) : null
  const maxBytes = presentation?.previewKind === "pdf" ? MAX_PDF_ATTACHMENT_PREVIEW_BYTES : MAX_TEXT_ATTACHMENT_PREVIEW_BYTES
  const unavailable = !presentation?.previewKind ? "This file type can’t be previewed"
    : selected?.sizeBytes !== undefined && selected.sizeBytes > maxBytes ? "This file is too large to preview" : null
  const content = useQuery({
    queryKey: applicationKey(owner, "attachment-preview", open ? selected?.url ?? null : null, presentation?.previewKind ?? null, maxBytes),
    enabled: open && selected !== null && unavailable === null, gcTime: 0, staleTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const token = captureApplicationOwner(owner)
      const assert = () => assertApplicationOwner(token, signal)
      assert()
      if (!selected || !presentation?.previewKind) throw new Error("No attachment selected")
      try {
        const response = await fetch(selected.url, { credentials: "same-origin", signal })
        assert()
        const result = presentation.previewKind === "pdf"
          ? { status: "ready" as const, kind: "pdf" as const, content: await readAttachmentBytes(response, maxBytes, signal), error: null }
          : { status: "ready" as const, kind: "text" as const, content: await readAttachmentText(response, maxBytes, signal), error: null }
        assert()
        return result
      } catch (error) { assert(); throw error }
    },
  }, owner.queryClient)
  const preview: PreviewState = !open || !selected ? IDLE_STATE
    : unavailable ? { status: "error", content: null, error: unavailable }
    : content.isError ? { status: "error", content: null, error: content.error instanceof Error ? content.error.message : "Couldn’t load this attachment" }
    : content.data ?? { status: "loading", content: null, error: null }

  const size = selected
    ? formatAttachmentSize(selected.sizeBytes) || selected.size
    : ""

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={selected?.name ?? "Attachment"}
      description={[selected?.contentType || presentation?.category, size].filter(Boolean).join(" · ")}
      footer={selected && (
        <AttachmentPreviewDownload attachment={selected} />
      )}
      resizable
      closeLabel="Close attachment preview"
      contentTestId={tid.attachmentPreviewSheet}
      bodyTestId={tid.attachmentPreviewContent}
      bodyClassName={cn(
        "flex min-h-0 flex-col",
        presentation?.previewKind === "pdf" && "overflow-hidden",
        (
          presentation?.previewKind === "code"
          || presentation?.previewKind === "text"
          || presentation?.previewKind === "pdf"
        ) && "p-0 sm:p-0",
      )}
    >
      {preview.status === "loading" && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading preview…
        </div>
      )}
      {preview.status === "error" && (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm font-medium">Preview unavailable</p>
          <p className="max-w-72 text-sm text-muted-foreground">{preview.error}</p>
        </div>
      )}
      {preview.status === "ready" && preview.kind === "text" && presentation?.previewKind === "markdown" && (
        <MessageBody text={preview.content} />
      )}
      {preview.status === "ready" && preview.kind === "text" && presentation?.previewKind !== "markdown" && (
        <CodePreview content={preview.content} language={presentation?.shikiLanguage ?? null} />
      )}
      {preview.status === "ready" && preview.kind === "pdf" && (
        <PdfPreview data={preview.content} />
      )}
    </CommunitySheet>
  )
}
