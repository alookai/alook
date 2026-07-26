"use client"

import { FileText, Download } from "lucide-react"
import { attachmentAspectRatio } from "./message"
import type { Attachment } from "./_types"

// Shared attachment renderer for the message row and the thread opener. Both
// sites render the same image-thumbnail / file-card list; only the message row
// wires an `onImageLoad` callback (used to keep the scroll anchored as images
// settle). Behavior on both sides is preserved: images get an aspect-ratio box
// + preview click, files get a download card.
export function MessageAttachments({
  attachments,
  onPreviewImage,
  onDownloadFile,
  onImageLoad,
}: {
  attachments: Attachment[]
  onPreviewImage?: (url: string) => void
  onDownloadFile?: (url: string) => void
  onImageLoad?: () => void
}) {
  return (
    <div className="mt-2 flex flex-col gap-2 pb-2">
      {attachments.map((a, i) =>
        a.kind === "image" ? (
          <button
            key={i}
            onClick={() => onPreviewImage?.(a.url)}
            className="block w-fit max-w-[320px] overflow-hidden rounded-lg border border-border transition-colors hover:border-primary/40"
          >
            <img src={a.url} alt={a.name} width={a.width} height={a.height} className="max-h-50 max-w-[320px] rounded-lg object-contain" style={{ aspectRatio: attachmentAspectRatio(a.width, a.height) }} onLoad={onImageLoad} />
          </button>
        ) : (
          <button
            key={i}
            onClick={() => onDownloadFile?.(a.url)}
            className="flex w-full max-w-[320px] items-center gap-3 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:bg-accent"
          >
            <FileText className="size-7 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-primary">{a.name}</div>
              <div className="text-xs text-muted-foreground">{a.size}</div>
            </div>
            <Download className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ),
      )}
    </div>
  )
}
