import { MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared"
import { isInlineAttachmentContentType } from "./attachment-content-type"

export type UploadTarget = {
  channelId?: string
  dmId?: string
  threadId?: string
}

export type UploadFileArgs = {
  receiptScope?: string
  assertActive?: (() => void) & { signal: AbortSignal }
  assertCommand?: () => void
  target: UploadTarget
  file: File
  thumbnailBlob?: Blob
  width?: number
  height?: number
}

// Uploads create pending attachments; sending reserves their IDs.
// Dimensions come from the upload request and also feed the optimistic view.
export type UploadFileResult = {
  id: string
  filename: string
  contentType: string
  size: number
  hasThumbnail?: boolean
  width?: number
  height?: number
}

export function appendGeneratedThumbnail(
  formData: FormData,
  originalContentType: string,
  thumbnailBlob?: Blob,
): boolean {
  if (
    !isInlineAttachmentContentType(originalContentType) ||
    !thumbnailBlob
  ) return false
  if (thumbnailBlob.type !== "image/jpeg") {
    throw new Error("Generated thumbnail must be image/jpeg")
  }
  if (thumbnailBlob.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) {
    throw new Error(
      `Generated thumbnail exceeds ${MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES / 1024} KiB`,
    )
  }
  formData.append("thumbnail", thumbnailBlob, "thumbnail.jpg")
  return true
}

export function buildAttachmentUploadFormData({
  file,
  thumbnailBlob,
  width,
  height,
}: Pick<UploadFileArgs, "file" | "thumbnailBlob" | "width" | "height">): FormData {
  const formData = new FormData()
  formData.append("file", file)
  appendGeneratedThumbnail(formData, file.type, thumbnailBlob)
  if (width !== undefined) formData.append("width", String(width))
  if (height !== undefined) formData.append("height", String(height))
  return formData
}

// Pair results with their original input indices; File references may repeat.
// Zip before filtering failures so each result retains its own dimensions.
export function zipUploadResultsWithDimensions(
  results: (UploadFileResult | null)[],
  attachments: { file: File; width?: number; height?: number }[],
): UploadFileResult[] {
  const zipped: (UploadFileResult | null)[] = results.map((r, i) =>
    r ? { ...r, width: attachments[i].width, height: attachments[i].height } : null,
  )
  return zipped.filter((x): x is UploadFileResult => x !== null)
}

