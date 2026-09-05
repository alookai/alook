import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  type CommunityReplicaIntentResponse,
  type MentionType,
} from "@alook/shared"
import { flushSync } from "react-dom"
import type { SendAttachment } from "./composer"
import type { ReplyTarget, Viewer } from "./message-channel-controller-types"
import { toOptimisticReplyPreview } from "@/lib/community/reply-preview"
import {
  sendNonce,
  tempMessageId,
  toAttachmentVm,
  zipUploadResultsWithDimensions,
  type UploadedAttachment,
} from "@/hooks/community/mutations"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { communityWsResetTypingThrottle } from "@/hooks/community/use-community-ws"
import { canonicalizeReplyContent } from "@/lib/community/reply-content"
import {
  commitCommunityReplicaIntentWal,
  discardCommunityReplicaIntentWal,
  persistCommunityReplicaIntent,
  applyCommunityReplicaIntentOutcomes,
} from "@/lib/community/replica/store"

type ChannelMessageScope = {
  kind: "channel"
  id: string
  serverId: string
}

type UploadFile = (input: {
  target: { channelId: string }
  file: File
  thumbnailBlob?: Blob
  width?: number
  height?: number
}) => Promise<UploadedAttachment>

type SendMessage = (input: {
  serverId: string
  channelId: string
  forumParentChannelId?: string
  content: string
  replyToId?: string
  mentionType?: MentionType
  attachments?: UploadedAttachment[]
  nonce: string
  author: Viewer
}) => Promise<unknown>

export async function runAcceptedMessageIntent({
  messageScope,
  nonce,
  uploadFileAsync,
  sendMessageAsync,
  channelId,
  forumParentChannelId,
  serverId,
  viewer,
}: {
  messageScope: ChannelMessageScope
  nonce: string
  uploadFileAsync: UploadFile
  sendMessageAsync: SendMessage
  channelId: string
  forumParentChannelId?: string
  serverId: string
  viewer: Viewer
}) {
  const streamStore = useMessageStreamStore.getState()
  const payload = streamStore.getRetryPayload(messageScope, nonce)
  if (!payload) return
  if (payload.localUploads.length === 0) {
    const intent = {
      intentId: nonce,
      kind: "message.send" as const,
      scope: { kind: "channel" as const, id: channelId },
      createdAt: payload.message.createdAt ?? new Date().toISOString(),
      payload: {
        content: payload.message.content ?? "",
        ...(payload.message.replyTo ? { replyToId: payload.message.replyTo.id } : {}),
        ...(payload.mentionType ? { mentionType: payload.mentionType } : {}),
      },
    }
    await persistCommunityReplicaIntent(viewer.id, intent)
    let response: CommunityReplicaIntentResponse
    try {
      response = await apiFetch("/api/community/replica/intents", {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
          intents: [intent],
        }),
      })
    } catch {
      return
    }
    await applyCommunityReplicaIntentOutcomes(viewer.id, response)
    const outcome = response.outcomes.find((item) => item.intentId === nonce)
    if (outcome?.status === "rejected") {
      streamStore.dispatch(messageScope, {
        type: "canonicalReject",
        nonce,
        reason: outcome.reason,
      })
      toastApiError(new Error(outcome.reason), outcome.reason)
    }
    return
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
          target: { channelId },
          file: upload.file,
          thumbnailBlob: upload.thumbnailBlob,
          width: upload.width,
          height: upload.height,
        }).catch((error) => {
          toastApiError(error, "Failed to attach file")
          return null
        }),
      ),
    )
    if (results.some((result) => result === null)) {
      streamStore.dispatch(messageScope, { type: "uploadFailed", nonce })
      return
    }
    uploadedAttachments = zipUploadResultsWithDimensions(
      results as UploadedAttachment[],
      [...payload.localUploads],
    )
    streamStore.dispatch(messageScope, {
      type: "uploadSettled",
      nonce,
      attachments: uploadedAttachments.map((attachment) => toAttachmentVm(channelId, attachment)),
    })
  }
  try {
    await sendMessageAsync({
      serverId,
      channelId,
      forumParentChannelId,
      content: payload.message.content ?? "",
      replyToId: payload.message.replyTo?.id,
      mentionType: payload.mentionType,
      attachments: uploadedAttachments,
      nonce,
      author: viewer,
    })
  } catch {
    return
  }
}

export function acceptChannelMessage({
  markdown,
  attachments,
  mentionType,
  messageScope,
  viewer,
  replyTo,
  runAcceptedIntent,
  channelId,
  clearReply,
}: {
  markdown: string
  attachments?: SendAttachment[]
  mentionType?: MentionType
  messageScope: ChannelMessageScope
  viewer: Viewer
  replyTo: ReplyTarget | null
  runAcceptedIntent: (nonce: string) => Promise<void>
  channelId: string
  clearReply: () => void
}): boolean {
  if (!markdown && !attachments?.length) return false
  const content = canonicalizeReplyContent(markdown, replyTo)
  const nonce = sendNonce()
  const createdAt = new Date().toISOString()
  const replicaIntent = attachments?.length ? null : {
    intentId: nonce,
    kind: "message.send" as const,
    scope: { kind: "channel" as const, id: channelId },
    createdAt,
    payload: {
      content,
      ...(replyTo ? { replyToId: replyTo.id } : {}),
      ...(mentionType ? { mentionType } : {}),
    },
  }
  if (replicaIntent) {
    try {
      commitCommunityReplicaIntentWal(viewer.id, replicaIntent)
    } catch (error) {
      toastApiError(error, "Couldn't save message locally")
      return false
    }
  }
  const createdPreviewUrls: string[] = []
  let accepted = false
  flushSync(() => {
    accepted = useMessageStreamStore.getState().accept(messageScope, {
      nonce,
      tempId: tempMessageId(),
      message: {
        type: "chat",
        authorId: viewer.id,
        authorName: viewer.name,
        authorAvatar: viewer.avatar,
        content,
        createdAt,
        ...(replyTo ? { replyTo: toOptimisticReplyPreview(replyTo) } : {}),
      },
      localUploads: attachments?.map((attachment) => {
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
      mentionType,
    })
  })
  if (!accepted) {
    if (replicaIntent) discardCommunityReplicaIntentWal(viewer.id, nonce)
    for (const url of createdPreviewUrls) URL.revokeObjectURL(url)
    return false
  }
  if (replicaIntent) {
    void persistCommunityReplicaIntent(viewer.id, replicaIntent).catch((error) => {
      toastApiError(error, "Message is saved locally but couldn't be queued yet")
    })
  }
  void runAcceptedIntent(nonce)
  communityWsResetTypingThrottle({ channelId })
  clearReply()
  return true
}
