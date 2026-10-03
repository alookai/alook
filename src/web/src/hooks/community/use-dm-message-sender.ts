"use client"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback } from "react"
import { useCommunityViewSource } from "./use-community-view-source"
import { useCommunityMutationOrigin } from "./community-origin"
import type { Msg } from "@/lib/community/models/message"
import type { SendAttachment } from "@/lib/community/models/message"
import { toastApiError } from "@/lib/api/client"
import { toOptimisticReplyPreview } from "@/lib/community/reply-preview"
import { canonicalizeReplyContent } from "@/lib/community/reply-content"
import {
  sendNonce,
  tempMessageId,
  toAttachmentVm,
  useSendDmMessage,
  useUploadFile,
  zipUploadResultsWithDimensions,
  type UploadedAttachment,
} from "@/hooks/community/mutations"

export type DmSendCommit =
  | { ok: true; message: { id: string; seq: number } }
  | { ok: false; error: Error }

export type DmSendReceipt =
  | { accepted: false }
  | { accepted: true; nonce: string; committed: Promise<DmSendCommit> }

export type AcceptDmMessageArgs = {
  assertActive?: (() => void) & { signal: AbortSignal }
  dmId: string
  content: string
  replyTo?: Msg["replyTo"]
  attachments?: SendAttachment[]
  author: { id: string; name: string; avatar: string }
  nonce?: string
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Failed to send message")
}

export function useDmMessageSender() {
  const communityRuntime = useCommunityRuntime()
  const source = useCommunityViewSource("dm-message-sender")
  const origin = useCommunityMutationOrigin()
  const { mutateAsync: uploadFileAsync } = useUploadFile()
  const { mutateAsync: sendDmMessageAsync } = useSendDmMessage()

  const runAcceptedIntent = useCallback(async (
    dmId: string,
    nonce: string,
    assertActive?: AcceptDmMessageArgs["assertActive"],
  ): Promise<DmSendCommit> => {
    const original = origin.begin().token
    const assert = () => { origin.assert(original); assertActive?.() }
    try { assert() } catch (error) { return { ok: false, error: asError(error) } }
    const scope = { kind: "dm" as const, id: dmId }
    const payload = communityRuntime.messageStream.actions.getRetryPayload(scope, nonce)
    if (!payload) {
      return { ok: false, error: new Error("Message intent is no longer available") }
    }

    let uploadedAttachments: UploadedAttachment[] | undefined
    if (payload.localUploads.length > 0 && payload.uploadStatus === "settled") {
      const projected = payload.message.attachments
      if (projected?.length === payload.localUploads.length) {
        uploadedAttachments = projected.map((attachment, index) => {
          const local = payload.localUploads[index]
          return {
            id: attachment.url.slice(attachment.url.lastIndexOf("/") + 1),
            filename: local.file.name,
            contentType: local.file.type,
            size: local.file.size,
            ...(attachment.kind === "image" && attachment.thumbnailUrl !== undefined
              ? { hasThumbnail: true }
              : {}),
            width: local.width,
            height: local.height,
          }
        })
      }
    }

    if (payload.localUploads.length > 0 && !uploadedAttachments) {
      const results = await Promise.all(
        payload.localUploads.map((upload) =>
          uploadFileAsync({
            assertActive,
            target: { dmId },
            file: upload.file,
            thumbnailBlob: upload.thumbnailBlob,
            width: upload.width,
            height: upload.height,
          }).catch((error) => {
            toastApiError(error, "Failed to attach file", assert)
            return null
          }),
        ),
      )
      if (results.some((result) => result === null)) {
        try { origin.assert(original) } catch (error) { return { ok: false, error: asError(error) } }
        communityRuntime.messageStream.actions.dispatch(scope, { type: "uploadFailed", nonce })
        return { ok: false, error: new Error("Failed to attach file") }
      }
      uploadedAttachments = zipUploadResultsWithDimensions(results, [...payload.localUploads])
      try { assert() } catch (error) {
        try { origin.assert(original); communityRuntime.messageStream.actions.dispatch(scope, { type: "uploadFailed", nonce }) } catch {}
        return { ok: false, error: asError(error) }
      }
      communityRuntime.messageStream.actions.dispatch(scope, {
        type: "uploadSettled",
        nonce,
        attachments: uploadedAttachments.map((attachment) =>
          toAttachmentVm(dmId, attachment)),
      })
    }

    try {
      assert()
      const result = await sendDmMessageAsync({
        dmId,
        content: payload.message.content ?? "",
        replyToId: payload.message.replyTo?.id,
        attachments: uploadedAttachments,
        nonce,
        assertActive,
      })
      return { ok: true, message: result.message }
    } catch (error) {
      return { ok: false, error: asError(error) }
    }
  }, [communityRuntime, origin, sendDmMessageAsync, uploadFileAsync])

  const accept = useCallback((args: AcceptDmMessageArgs): DmSendReceipt => {
    const assertActive = args.assertActive ?? source.capture()
    assertActive()
    if (!args.content && !args.attachments?.length) return { accepted: false }
    const content = canonicalizeReplyContent(args.content, args.replyTo)
    const nonce = args.nonce ?? sendNonce()
    const createdPreviewUrls: string[] = []
    const accepted = communityRuntime.messageStream.actions.accept(
      { kind: "dm", id: args.dmId },
      {
        nonce,
        tempId: tempMessageId(),
        message: {
          type: "chat",
          authorId: args.author.id,
          authorName: args.author.name,
          authorAvatar: args.author.avatar,
          content,
          createdAt: new Date().toISOString(),
          ...(args.replyTo ? { replyTo: toOptimisticReplyPreview(args.replyTo) } : {}),
        },
        localUploads: args.attachments?.map((attachment) => {
          const previewObjectUrl = attachment.previewObjectUrl ?? URL.createObjectURL(attachment.file)
          if (!attachment.previewObjectUrl) createdPreviewUrls.push(previewObjectUrl)
          return {
            file: attachment.file,
            thumbnailBlob: attachment.thumbnailBlob,
            previewObjectUrl,
            width: attachment.width,
            height: attachment.height,
          }
        }) ?? [],
      },
    )
    if (!accepted) {
      for (const url of createdPreviewUrls) URL.revokeObjectURL(url)
      return { accepted: false }
    }
    return {
      accepted: true,
      nonce,
      committed: runAcceptedIntent(args.dmId, nonce, assertActive),
    }
  }, [communityRuntime.messageStream.actions, runAcceptedIntent, source])

  const retry = useCallback((dmId: string, nonce: string): Promise<DmSendCommit> => {
    const assertActive = source.capture()
    assertActive()
    communityRuntime.messageStream.actions.dispatch(
      { kind: "dm", id: dmId },
      { type: "retry", nonce },
    )
    return runAcceptedIntent(dmId, nonce, assertActive)
  }, [communityRuntime.messageStream.actions, runAcceptedIntent, source])

  return { accept, retry }
}
