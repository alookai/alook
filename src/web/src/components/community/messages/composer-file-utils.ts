import type { PendingFile } from "@/hooks/use-file-attachments"
import type { SendAttachment } from "@/lib/community/models/message"

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
