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
