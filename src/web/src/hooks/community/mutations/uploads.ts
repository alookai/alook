"use client"

import { useMutation } from "@tanstack/react-query"

/**
 * File upload mutations. These POST multipart to the channel/dm/thread upload
 * routes; the response includes the R2-hosted URL + metadata. Consumers pass
 * the returned attachment payload into `useSendMessage` / `useSendDmMessage`
 * so the message row references the freshly uploaded blob.
 */

export type UploadTarget = {
  channelId?: string
  dmId?: string
  threadId?: string
}

export type UploadFileArgs = { target: UploadTarget; file: File }

export type UploadFileResult = {
  url: string
  filename: string
  contentType: string
  size: number
}

export type UploadedAttachment = UploadFileResult & { width?: number; height?: number }

/**
 * Zip each upload result back to its ORIGINAL INDEX in the input attachments
 * array (not by `File` identity — `Promise.all` already preserves input
 * order regardless of completion order, so a plain index is enough and can't
 * collide if two attachments happen to share a `File` reference) to pull
 * width/height in. Dimensions never cross the network to the upload
 * endpoint; they're only known client-side and get attached here, after the
 * upload resolves.
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
  if (target.threadId) return `/api/community/threads/${target.threadId}/upload`
  if (target.dmId) return `/api/community/dm/${target.dmId}/upload`
  if (target.channelId) return `/api/community/channels/${target.channelId}/upload`
  return null
}

export function useUploadFile() {
  return useMutation<UploadFileResult, Error, UploadFileArgs>({
    mutationFn: async ({ target, file }) => {
      const path = uploadPath(target)
      if (!path) throw new Error("Upload target requires channelId, dmId, or threadId")
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(path, {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      if (!res.ok) throw new Error("Upload failed")
      return (await res.json()) as UploadFileResult
    },
  })
}
