import type { PendingFile, useFileAttachments } from "@/hooks/use-file-attachments"
import type { SendAttachment } from "@/lib/community/models/message"
import type { ComposerViewProps } from "./composer-view"

export const LONG_PASTE_ATTACHMENT_THRESHOLD = 1_000

export type LongPasteAttachment = {
  file: File
  nextIndex: number
}

export function createLongPasteAttachment(
  text: string | undefined,
  existingFileNames: readonly string[],
  startIndex = 1,
): LongPasteAttachment | null {
  if (!text || text.length <= LONG_PASTE_ATTACHMENT_THRESHOLD) return null

  const occupiedNames = new Set(existingFileNames)
  let index = Math.max(1, startIndex)
  while (occupiedNames.has(`copy-${index}.md`)) index++

  return {
    file: new File([text], `copy-${index}.md`, {
      type: "text/markdown",
    }),
    nextIndex: index + 1,
  }
}

export function pendingFilesToSendAttachments(
  pendingFiles: PendingFile[],
): SendAttachment[] | undefined {
  if (pendingFiles.length === 0) return undefined
  return pendingFiles.map((pendingFile) => ({
    file: pendingFile.file,
    thumbnailBlob: pendingFile.thumbnailBlob ?? undefined,
    previewObjectUrl: pendingFile.thumbnailUrl ?? undefined,
    width: pendingFile.width,
    height: pendingFile.height,
  }))
}

export function clipboardFiles(
  items: DataTransferItemList | undefined,
): File[] {
  if (!items) return []
  const files: File[] = []
  for (let index = 0; index < items.length; index++) {
    if (items[index].kind !== "file") continue
    const file = items[index].getAsFile()
    if (file) files.push(file)
  }
  return files
}

type AttachmentViewHandlers = Pick<ComposerViewProps,
  "onDragEnter" | "onDragLeave" | "onDragOver" | "onDrop" |
  "onFileSelect" | "removePendingFile" | "onUploadFile">
type AttachmentInputOwner = Pick<ReturnType<typeof useFileAttachments>,
  "handleDragEnter" | "handleDragLeave" | "handleDragOver" | "handleDrop" |
  "handleFileSelect" | "removePendingFile" | "fileInputRef">

export function createComposerAttachmentInputHandlers(
  isActive: () => boolean,
  attachments: AttachmentInputOwner,
  focusAfterDrop: () => void,
): AttachmentViewHandlers {
  const guardDrag = (handler: ComposerViewProps["onDrop"]): ComposerViewProps["onDrop"] => (event) => {
    if (!isActive()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    handler(event)
  }
  return {
    onDragEnter: guardDrag(attachments.handleDragEnter),
    onDragLeave: attachments.handleDragLeave,
    onDragOver: guardDrag(attachments.handleDragOver),
    onDrop: guardDrag((event) => {
      attachments.handleDrop(event)
      focusAfterDrop()
    }),
    onFileSelect: (event) => {
      if (!isActive()) {
        event.currentTarget.value = ""
        return
      }
      attachments.handleFileSelect(event)
    },
    removePendingFile: (index) => {
      if (isActive()) attachments.removePendingFile(index)
    },
    onUploadFile: () => {
      if (isActive()) attachments.fileInputRef.current?.click()
    },
  }
}
