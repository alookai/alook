"use client"

import type { LucideIcon } from "lucide-react"
import {
  Archive,
  CircleCheck,
  Download,
  Eye,
  File,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LoaderCircle,
  Presentation,
  RefreshCw,
} from "lucide-react"
import type { FileAttachment } from "@/lib/community/models/message"
import { MediaAttachmentBlock } from "./media-attachment-block"
import { tid } from "@/lib/community/testids"
import {
  resolveAttachmentPresentation,
  type AttachmentCategory,
} from "@/lib/community/attachment-presentation"
import {
  attachmentDownloadStatusText,
  useAttachmentDownload,
} from "@/lib/community/attachment-download"

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
}: {
  attachment: FileAttachment
  onPreview?: (attachment: FileAttachment) => void
}) {
  const presentation = resolveAttachmentPresentation(attachment.name, attachment.contentType)
  if (presentation.category === "audio" || presentation.category === "video") {
    return (
      <MediaAttachmentBlock
        attachment={attachment}
        mediaKind={presentation.category}
      />
    )
  }
  return <FileAttachmentCard attachment={attachment} onPreview={onPreview} />
}

function FileAttachmentCard({
  attachment,
  onPreview,
}: {
  attachment: FileAttachment
  onPreview?: (attachment: FileAttachment) => void
}) {
  const presentation = resolveAttachmentPresentation(attachment.name, attachment.contentType)
  const download = useAttachmentDownload(attachment)
  const Icon = CATEGORY_ICONS[presentation.category]
  const canPreview = presentation.previewKind !== null && !!onPreview
  const statusText = canPreview ? null : attachmentDownloadStatusText(download.state)
  const ActionIcon = canPreview
    ? Eye
    : download.state.status === "downloading"
      ? LoaderCircle
      : download.state.status === "success"
        ? CircleCheck
        : download.state.status === "error"
          ? RefreshCw
          : Download
  const action = canPreview
    ? "Preview"
    : download.state.status === "downloading"
      ? "Downloading"
      : download.state.status === "error"
        ? "Retry download"
        : "Download"

  return (
    <button
      type="button"
      data-testid={tid.attachmentCard(attachment.name)}
      data-attachment-category={presentation.category}
      onClick={() => canPreview
        ? onPreview(attachment)
        : void download.start()}
      className="flex w-full max-w-[320px] items-center gap-3 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      aria-label={`${action} ${attachment.name}`}
      aria-busy={!canPreview && download.state.status === "downloading"}
      disabled={!canPreview && download.state.status === "downloading"}
    >
      <Icon className="size-7 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-primary">{attachment.name}</div>
        {statusText ? (
          <div
            role={download.state.status === "error" ? "alert" : "status"}
            className="text-xs text-muted-foreground"
          >
            {statusText}
          </div>
        ) : attachment.size && (
          <div className="text-xs text-muted-foreground">{attachment.size}</div>
        )}
      </div>
      <ActionIcon
        className={`size-4 shrink-0 text-muted-foreground ${download.state.status === "downloading" ? "animate-spin motion-reduce:animate-none" : ""}`}
      />
    </button>
  )
}
