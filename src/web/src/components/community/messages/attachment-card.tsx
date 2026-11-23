"use client"

import type { LucideIcon } from "lucide-react"
import { FileAudio, FileCode2, FileVideo } from "lucide-react";
import { Archive, CircleCheck, Download, Eye, File, FileImage, FileSpreadsheet, FileText, LoaderCircle, Presentation, RefreshCw } from "@/components/icons/lucide";
import type { FileAttachment } from "@/lib/community/models/message"
import { MediaAttachmentBlock } from "./media-attachment-block"
import { VideoAttachmentBlock } from "./video-attachment-block"
import { AttachmentContextMenu } from "./attachment-context-menu"
import { tid } from "@/lib/community/testids"
import {
  resolveAttachmentPresentation,
  type AttachmentCategory,
} from "@/lib/community/attachment-presentation"
import {
  fileDownloadStatusText,
  useFileDownload,
} from "@/lib/file-download"

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
  contextMenuDisabled,
}: {
  attachment: FileAttachment
  onPreview?: (attachment: FileAttachment) => void
  contextMenuDisabled?: boolean
}) {
  const presentation = resolveAttachmentPresentation(attachment.name, attachment.contentType)
  if (presentation.category === "video") {
    return <VideoAttachmentBlock attachment={attachment} contextMenuDisabled={contextMenuDisabled} />
  }
  if (presentation.category === "audio") {
    return (
      <MediaAttachmentBlock
        attachment={attachment}
        mediaKind={presentation.category}
        contextMenuDisabled={contextMenuDisabled}
      />
    )
  }
  return <FileAttachmentCard attachment={attachment} onPreview={onPreview} contextMenuDisabled={contextMenuDisabled} />
}

function FileAttachmentCard({
  attachment,
  onPreview,
  contextMenuDisabled,
}: {
  attachment: FileAttachment
  onPreview?: (attachment: FileAttachment) => void
  contextMenuDisabled?: boolean
}) {
  const presentation = resolveAttachmentPresentation(attachment.name, attachment.contentType)
  const download = useFileDownload(attachment)
  const Icon = CATEGORY_ICONS[presentation.category]
  const canPreview = presentation.previewKind !== null && !!onPreview
  const statusText = canPreview ? null : fileDownloadStatusText(download.state)
  const ActionIcon = canPreview
    ? Eye
    : download.state.status === "downloading"
      ? LoaderCircle
      : (download.state.status === "saved" || download.state.status === "started")
        ? CircleCheck
        : download.state.status === "error"
          ? RefreshCw
          : Download
  const action = canPreview
    ? "Preview"
    : download.state.status === "downloading"
      ? "Cancel download"
      : download.state.status === "error"
        ? "Retry download"
        : "Download"

  const card = (
    <button
      type="button"
      data-testid={tid.attachmentCard(attachment.name)}
      data-attachment-category={presentation.category}
      onClick={() => canPreview
        ? onPreview(attachment)
        : download.state.status === "downloading" ? download.cancel() : void download.start()}
      className="flex w-full max-w-[320px] items-center gap-2 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      aria-label={`${action} ${attachment.name}`}
      aria-busy={!canPreview && download.state.status === "downloading"}
    >
      <Icon className="size-7 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-sm font-medium text-foreground">{attachment.name}</div>
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
  return <AttachmentContextMenu
    attachmentName={attachment.name}
    trigger={card}
    disabled={contextMenuDisabled}
    onOpen={onPreview ? () => onPreview(attachment) : undefined}
    onDownload={() => { void download.start() }}
    downloading={download.state.status === "downloading"}
  />
}
