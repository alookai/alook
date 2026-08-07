"use client"

import { useCallback } from "react"
import type { Msg } from "@/components/community/_types"
import type { SendAttachment } from "@/components/community/composer"
import { toastApiError } from "@/lib/api/client"
import { useMessageStreamStore } from "@/stores/community/message-stream"
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
  const { mutateAsync: uploadFileAsync } = useUploadFile()
  const { mutateAsync: sendDmMessageAsync } = useSendDmMessage()

  const runAcceptedIntent = useCallback(async (
    dmId: string,
    nonce: string,
  ): Promise<DmSendCommit> => {
    const scope = { kind: "dm" as const, id: dmId }
    const streamStore = useMessageStreamStore.getState()
    const payload = streamStore.getRetryPayload(scope, nonce)
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
            url: attachment.url,
            filename: local.file.name,
            contentType: local.file.type,
            size: local.file.size,
            width: local.width,
            height: local.height,
          }
        })
      }
    }

    if (payload.localUploads.length > 0 && !uploadedAttachments) {
      const results = await Promise.all(
        payload.localUploads.map((upload) =>
          uploadFileAsync({ target: { dmId }, file: upload.file }).catch((error) => {
            toastApiError(error, "Failed to attach file")
            return null
          }),
        ),
      )
      if (results.some((result) => result === null)) {
        streamStore.dispatch(scope, { type: "uploadFailed", nonce })
        return { ok: false, error: new Error("Failed to attach file") }
      }
      uploadedAttachments = zipUploadResultsWithDimensions(results, [...payload.localUploads])
      streamStore.dispatch(scope, {
        type: "uploadSettled",
        nonce,
        attachments: uploadedAttachments.map(toAttachmentVm),
      })
    }

    try {
      const result = await sendDmMessageAsync({
        dmId,
        content: payload.message.content ?? "",
        replyToId: payload.message.replyTo?.id,
        attachments: uploadedAttachments,
        nonce,
      })
      return { ok: true, message: result.message }
    } catch (error) {
      return { ok: false, error: asError(error) }
    }
  }, [sendDmMessageAsync, uploadFileAsync])

  const accept = useCallback((args: AcceptDmMessageArgs): DmSendReceipt => {
    if (!args.content && !args.attachments?.length) return { accepted: false }
    const nonce = args.nonce ?? sendNonce()
    const createdPreviewUrls: string[] = []
    const accepted = useMessageStreamStore.getState().accept(
      { kind: "dm", id: args.dmId },
      {
        nonce,
        tempId: tempMessageId(),
        message: {
          type: "chat",
          authorId: args.author.id,
          authorName: args.author.name,
          authorAvatar: args.author.avatar,
          content: args.content,
          createdAt: new Date().toISOString(),
          ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        },
        localUploads: args.attachments?.map((attachment) => {
          const previewObjectUrl = attachment.previewObjectUrl ?? URL.createObjectURL(attachment.file)
          if (!attachment.previewObjectUrl) createdPreviewUrls.push(previewObjectUrl)
          return {
            file: attachment.file,
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
      committed: runAcceptedIntent(args.dmId, nonce),
    }
  }, [runAcceptedIntent])

  const retry = useCallback((dmId: string, nonce: string): Promise<DmSendCommit> => {
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: dmId },
      { type: "retry", nonce },
    )
    return runAcceptedIntent(dmId, nonce)
  }, [runAcceptedIntent])

  return { accept, retry }
}
