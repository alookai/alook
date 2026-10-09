"use client"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useCommunityViewSource } from "./use-community-view-source"
import { useCommunityMutationOrigin } from "./community-origin"
import { getConfirmedSentMessage, type SendMessageArgs, type SendMessageResult } from "./mutations/messages"
import type { SendAttachment } from "@/lib/community/models/message"
import { acceptMessageIntent, prepareMessageIntent, messageSendError } from "@/lib/community/message-send-intent"
import {
  useSendDmMessage,
  useUploadFile,
} from "@/hooks/community/mutations"

export type DmSendCommit =
  | { ok: true; message: Pick<SendMessageResult["message"], "id" | "seq"> }
  | { ok: false; error: Error }

export type DmSendReceipt =
  | { accepted: false }
  | { accepted: true; nonce: string; committed: Promise<DmSendCommit> }

export type AcceptDmMessageArgs = Pick<SendMessageArgs, "assertActive" | "content" | "replyTo" | "author" | "nonce"> & {
  dmId: string
  attachments?: SendAttachment[]
}

export function useDmMessageSender() {
  const communityRuntime = useCommunityRuntime()
  const queryClient = useQueryClient()
  const source = useCommunityViewSource("dm-message-sender")
  const origin = useCommunityMutationOrigin()
  const { mutateAsync: uploadFileAsync } = useUploadFile()
  const { mutateAsync: sendDmMessageAsync } = useSendDmMessage()

  const runAcceptedIntent = useCallback(async (
    dmId: string,
    nonce: string,
    original: ReturnType<typeof origin.begin>["token"],
    assertCommand: () => void,
    assertActive?: AcceptDmMessageArgs["assertActive"],
  ): Promise<DmSendCommit> => {
    const assert = () => { origin.assert(original); assertCommand() }
    const scope = { kind: "dm" as const, id: dmId }
    try {
      const prepared = await prepareMessageIntent({ runtime: communityRuntime, scope, nonce,
        assertOwner: assert, assertActive, assertCommand, uploadFileAsync, target: { dmId } })
      if (!prepared.ok) return prepared
      const { payload, attachments: uploadedAttachments } = prepared
      assert()
      let result: SendMessageResult
      try {
        result = await sendDmMessageAsync({
          dmId,
          content: payload.message.content ?? "",
          replyToId: payload.message.replyTo?.id,
          attachments: uploadedAttachments,
          nonce,
          assertActive,
          assertCommand,
        })
      } catch (error) {
        const confirmed = getConfirmedSentMessage(error, origin, original, dmId, nonce, assertActive, assertCommand)
        if (confirmed) return { ok: true, message: { id: confirmed.id, seq: confirmed.seq } }
        throw error
      }
      return { ok: true, message: result.message }
    } catch (error) {
      return { ok: false, error: messageSendError(error) }
    }
  }, [communityRuntime, origin, sendDmMessageAsync, uploadFileAsync])

  const accept = useCallback((args: AcceptDmMessageArgs): DmSendReceipt => {
    const assertActive = args.assertActive ?? source.capture()
    assertActive()
    const original = captureCommunityLiveSnapshotToken(queryClient, args.dmId)
    const assertCommand = () => { origin.assert(original); assertCommunityLiveSnapshotTokenCurrent(queryClient, original, undefined) }
    assertCommand()
    const nonce = acceptMessageIntent(communityRuntime, { kind: "dm", id: args.dmId }, args)
    if (nonce === undefined) return { accepted: false }
    return {
      accepted: true,
      nonce,
      committed: runAcceptedIntent(args.dmId, nonce, original, assertCommand, assertActive),
    }
  }, [communityRuntime, origin, queryClient, runAcceptedIntent, source])

  const retry = useCallback((dmId: string, nonce: string, view?: AcceptDmMessageArgs["assertActive"]): Promise<DmSendCommit> => {
    const assertActive = view ?? source.capture()
    assertActive()
    const original = captureCommunityLiveSnapshotToken(queryClient, dmId)
    const assertCommand = () => { origin.assert(original); assertCommunityLiveSnapshotTokenCurrent(queryClient, original, undefined) }
    assertCommand()
    communityRuntime.messageStream.actions.dispatch(
      { kind: "dm", id: dmId },
      { type: "retry", nonce },
    )
    return runAcceptedIntent(dmId, nonce, original, assertCommand, assertActive)
  }, [communityRuntime, origin, queryClient, runAcceptedIntent, source])

  return { accept, retry }
}
