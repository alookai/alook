"use client"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback } from "react"
import { useCommunityViewSource } from "./use-community-view-source"
import { useCommunityMutationOrigin } from "./community-origin"
import type { SendMessageArgs, SendMessageResult } from "./mutations/messages"
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
    const scope = { kind: "dm" as const, id: dmId }
    try {
      const prepared = await prepareMessageIntent({ runtime: communityRuntime, scope, nonce,
        assertOwner: () => origin.assert(original), assertActive, uploadFileAsync, target: { dmId } })
      if (!prepared.ok) return prepared
      const { payload, attachments: uploadedAttachments } = prepared
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
      return { ok: false, error: messageSendError(error) }
    }
  }, [communityRuntime, origin, sendDmMessageAsync, uploadFileAsync])

  const accept = useCallback((args: AcceptDmMessageArgs): DmSendReceipt => {
    const assertActive = args.assertActive ?? source.capture()
    assertActive()
    const nonce = acceptMessageIntent(communityRuntime, { kind: "dm", id: args.dmId }, args)
    if (nonce === undefined) return { accepted: false }
    return {
      accepted: true,
      nonce,
      committed: runAcceptedIntent(args.dmId, nonce, assertActive),
    }
  }, [communityRuntime, runAcceptedIntent, source])

  const retry = useCallback((dmId: string, nonce: string): Promise<DmSendCommit> => {
    const assertActive = source.capture()
    assertActive()
    communityRuntime.messageStream.actions.dispatch(
      { kind: "dm", id: dmId },
      { type: "retry", nonce },
    )
    return runAcceptedIntent(dmId, nonce, assertActive)
  }, [communityRuntime, runAcceptedIntent, source])

  return { accept, retry }
}
