"use client"

import type { LucideIcon } from "lucide-react"
import {
  Archive,
  Download,
  Eye,
  File,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react"
import type { FileAttachment } from "./_types"
import { MediaAttachmentBlock } from "./media-attachment-block"
import { tid } from "@/lib/community/testids"
import {
  resolveAttachmentPresentation,
  type AttachmentCategory,
} from "@/lib/community/attachment-presentation"

const CATEGORY_ICONS: Record<AttachmentCategory, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileText,
  code: FileCode2,
  audio: FileAudio,
  video: FileVideo,
  archive: Archive,
  unknown: File,
}

export function AttachmentCard({
  attachment,
  onPreview,
  onDownload,
}: {
  attachment: FileAttachment
  onPreview?: (attachment: FileAttachment) => void
  onDownload?: (url: string, name: string) => void
}) {
  const presentation = resolveAttachmentPresentation(attachment.name, attachment.contentType)
  if (presentation.category === "audio" || presentation.category === "video") {
    return (
      <MediaAttachmentBlock
        attachment={attachment}
        mediaKind={presentation.category}
        onDownload={onDownload}
      />
    )
  }
  const Icon = CATEGORY_ICONS[presentation.category]
  const canPreview = presentation.previewKind !== null && !!onPreview
  const ActionIcon = canPreview ? Eye : Download
  const action = canPreview ? "Preview" : "Download"

  return (
    <button
      type="button"
      data-testid={tid.attachmentCard(attachment.name)}
      data-attachment-category={presentation.category}
      onClick={() => canPreview
        ? onPreview(attachment)
        : onDownload?.(attachment.url, attachment.name)}
      className="flex w-full max-w-[320px] items-center gap-3 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      aria-label={`${action} ${attachment.name}`}
    >
      <Icon className="size-7 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-primary">{attachment.name}</div>
        {attachment.size && (
          <div className="text-xs text-muted-foreground">{attachment.size}</div>
        )}
      </div>
      <ActionIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
