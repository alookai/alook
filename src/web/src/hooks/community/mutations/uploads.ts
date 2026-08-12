"use client"

import { useMutation } from "@tanstack/react-query"
import { MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared"
import { readUploadError } from "@/lib/api/client"
import { isInlineAttachmentContentType } from "@/lib/community/attachment-content-type"

/**
 * File upload mutations. These POST multipart to the channel/dm/thread upload
 * routes; the response includes a stable attachment id + metadata. Consumers
 * pass the returned attachment payload into `useSendMessage` /
 * `useSendDmMessage` so the message row references the freshly uploaded blob.
 */

export type UploadTarget = {
  channelId?: string
  dmId?: string
  threadId?: string
}

export type UploadFileArgs = {
  target: UploadTarget
  file: File
  thumbnailBlob?: Blob
  width?: number
  height?: number
}

// Reserve-by-id (route/disc step 2b): the upload now creates a PENDING
// attachment row and returns its stable `id` (mirroring the bot flow). The
// composer holds the id in-memory and passes it to `send`; the server links it
// via reserve. The old `url` field is gone — the display URL is id-addressed
// and derived client-side (see `toAttachmentVm`). Image dimensions ride the
// UPLOAD request (single source) and echo back here for the optimistic VM.
export type UploadFileResult = {
  id: string
  filename: string
  contentType: string
  size: number
  hasThumbnail?: boolean
  width?: number
  height?: number
}

export type UploadedAttachment = UploadFileResult & { width?: number; height?: number }

export function appendGeneratedThumbnail(
  formData: FormData,
  originalContentType: string,
  thumbnailBlob?: Blob,
): boolean {
  if (
    !isInlineAttachmentContentType(originalContentType) ||
    !thumbnailBlob ||
    thumbnailBlob.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
  ) return false
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

/**
 * Zip each upload result back to its ORIGINAL INDEX in the input attachments
 * array (not by `File` identity — `Promise.all` already preserves input
 * order regardless of completion order, so a plain index is enough and can't
 * collide if two attachments happen to share a `File` reference) to pull
 * width/height in. Dimensions also ride the upload multipart so the pending
 * row can persist them; this zip keeps the optimistic result aligned with the
 * same original input index after the response resolves.
 *
 * The zip MUST happen before dropping failed (`null`) results, or indices
 * between `results` and `attachments` misalign once a failed upload is
 * filtered out — see plans/attachment-image-dimensions.md's "Exact zip
 * transform" note.
 */
export function zipUploadResultsWithDimensions(
  results: (UploadFileResult | null)[],
  attachments: { file: File; width?: number; height?: number }[],
): UploadedAttachment[] {
  const zipped: (UploadedAttachment | null)[] = results.map((r, i) =>
    r ? { ...r, width: attachments[i].width, height: attachments[i].height } : null,
  )
  return zipped.filter((x): x is UploadedAttachment => x !== null)
}

function uploadPath(target: UploadTarget): string | null {
  // Thread / DM / channel are all channel rows in one id-space → one upload
  // door. Whichever id the target carries, it's a channelId to channels/{id}.
  // Canonical attachments door (route/disc trunk): POST channels/{id}/attachments
  // (re-pointed off the old channels/{id}/upload, which stays alive through the
  // deploy window and is deleted at the flat-delete step). The response is the
  // stable attachment-id carrier consumed by the later message send.
  const id = target.threadId ?? target.dmId ?? target.channelId
  return id ? `/api/community/channels/${id}/attachments` : null
}

export function useUploadFile() {
  return useMutation<UploadFileResult, Error, UploadFileArgs>({
    mutationFn: async ({ target, file, thumbnailBlob, width, height }) => {
      const path = uploadPath(target)
      if (!path) throw new Error("Upload target requires channelId, dmId, or threadId")
      const formData = buildAttachmentUploadFormData({ file, thumbnailBlob, width, height })
      const res = await fetch(path, {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      if (!res.ok) throw await readUploadError(res, "Upload failed")
      return (await res.json()) as UploadFileResult
    },
  })
}
