"use client"
import { buildAttachmentUploadFormData, type UploadTarget, type UploadFileArgs, type UploadFileResult } from "@/lib/community/attachment-upload"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useCommunityMutationOrigin } from "../community-origin"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

function uploadPath(target: UploadTarget): string | null {

  const id = target.threadId ?? target.dmId ?? target.channelId
  return id ? `/api/community/channels/${id}/attachments` : null
}

export function useUploadFile(options: { gcTime?: number } = {}) {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type Intent = UploadFileArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<UploadFileResult, Error, Intent>({ meta: { observabilityAction: "attachment.upload" },
    mutationKey: ["community", "file-upload"], gcTime: options.gcTime ?? 0,
    mutationFn: async ({ target, file, thumbnailBlob, width, height, original, assertActive, assertCommand }) => {
      origin.assert(original); (assertCommand ?? assertActive)?.()
      const path = uploadPath(target)
      if (!path) throw new Error("Upload target requires channelId, dmId, or threadId")
      const formData = buildAttachmentUploadFormData({ file, thumbnailBlob, width, height })
      return origin.request<UploadFileResult>(original, path, { method: "POST", body: formData, signal: assertCommand ? undefined : assertActive?.signal, assertActive: assertCommand ?? assertActive })
    },
  })
  const capture = useCallback((input: UploadFileArgs): Intent => { (input.assertCommand ?? input.assertActive)?.(); return { ...input, original: input.assertCommand ? captureCommunityLiveSnapshotToken(queryClient, input.target.threadId ?? input.target.dmId ?? input.target.channelId) : origin.begin().token } }, [origin, queryClient])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
