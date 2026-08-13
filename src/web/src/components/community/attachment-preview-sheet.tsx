"use client"

import { useEffect, useState } from "react"
import { ArrowLeft, Download, Loader2, X } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SheetResizeHandle, useSheetResize } from "@/components/ui/sheet-resize-handle"
import { cn } from "@/lib/utils"
import { MessageBody } from "./message-body"
import { CodePreview } from "./code-preview"
import type { FileAttachment } from "./_types"
import { tid } from "@/lib/community/testids"
import {
  formatAttachmentSize,
  MAX_TEXT_ATTACHMENT_PREVIEW_BYTES,
  resolveAttachmentPresentation,
} from "@/lib/community/attachment-presentation"

type PreviewState =
  | { status: "idle" | "loading"; content: null; error: null }
  | { status: "ready"; content: string; error: null }
  | { status: "error"; content: null; error: string }

const IDLE_STATE: PreviewState = { status: "idle", content: null, error: null }

export async function readAttachmentText(
  response: Response,
  maxBytes = MAX_TEXT_ATTACHMENT_PREVIEW_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.ok) throw new Error(`Couldn’t load this attachment (${response.status})`)
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("This file is too large to preview")
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error("This file is too large to preview")
    return new TextDecoder().decode(bytes)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let byteLength = 0
  let content = ""
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new Error("This file is too large to preview")
      }
      content += decoder.decode(value, { stream: true })
    }
    return content + decoder.decode()
  } finally {
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
  const [selected, setSelected] = useState<FileAttachment | null>(attachment)
  const [preview, setPreview] = useState<PreviewState>(IDLE_STATE)
  const { width, onPointerDown, onPointerMove, onPointerUp } = useSheetResize({
    defaultWidth: 520,
    minWidth: 320,
    maxWidthRatio: 0.8,
  })

  useEffect(() => {
    if (attachment) setSelected(attachment)
  }, [attachment])

  useEffect(() => {
    if (!open || !selected) {
      setPreview(IDLE_STATE)
      return
    }
    const presentation = resolveAttachmentPresentation(selected.name, selected.contentType)
    if (!presentation.previewKind) {
      setPreview({ status: "error", content: null, error: "This file type can’t be previewed" })
      return
    }
    if (selected.sizeBytes !== undefined && selected.sizeBytes > MAX_TEXT_ATTACHMENT_PREVIEW_BYTES) {
      setPreview({ status: "error", content: null, error: "This file is too large to preview" })
      return
    }

    const controller = new AbortController()
    let active = true
    setPreview({ status: "loading", content: null, error: null })
    fetch(selected.url, { credentials: "same-origin", signal: controller.signal })
      .then((response) => readAttachmentText(response, MAX_TEXT_ATTACHMENT_PREVIEW_BYTES, controller.signal))
      .then((content) => {
        if (active) setPreview({ status: "ready", content, error: null })
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return
        setPreview({
          status: "error",
          content: null,
          error: error instanceof Error ? error.message : "Couldn’t load this attachment",
        })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [open, selected])

  const presentation = selected
    ? resolveAttachmentPresentation(selected.name, selected.contentType)
    : null
  const size = selected
    ? formatAttachmentSize(selected.sizeBytes) || selected.size
    : ""

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-testid={tid.attachmentPreviewSheet}
        side="right"
        showCloseButton={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <SheetResizeHandle
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        <SheetHeader className="pr-4 sm:pr-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "size-11 shrink-0 sm:hidden")}
              onClick={() => onOpenChange(false)}
              aria-label="Close attachment preview"
            >
              <ArrowLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{selected?.name ?? "Attachment"}</SheetTitle>
              <SheetDescription className="truncate">
                {[selected?.contentType || presentation?.category, size].filter(Boolean).join(" · ")}
              </SheetDescription>
            </div>
            {selected && (
              <a
                data-testid={tid.attachmentPreviewDownload}
                href={selected.url}
                download={selected.name}
                className={buttonVariants({ variant: "outline", size: "sm", className: "h-11 sm:h-7" })}
              >
                <Download className="size-3.5" />
                Download
              </a>
            )}
            <button
              type="button"
              className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "size-11 sm:size-7" })}
              onClick={() => onOpenChange(false)}
              aria-label="Close attachment preview"
            >
              <X className="size-4" />
            </button>
          </div>
        </SheetHeader>
        <SheetBody
          data-testid={tid.attachmentPreviewContent}
          className={cn(
            "flex min-h-0 flex-col",
            (presentation?.previewKind === "code" || presentation?.previewKind === "text") && "p-0 sm:p-0",
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
          {preview.status === "ready" && presentation?.previewKind === "markdown" && (
            <MessageBody text={preview.content} />
          )}
          {preview.status === "ready" && presentation?.previewKind !== "markdown" && (
            <CodePreview content={preview.content} language={presentation?.shikiLanguage ?? null} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
