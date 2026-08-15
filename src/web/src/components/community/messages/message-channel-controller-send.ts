import type { MentionType } from "@alook/shared"
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
import { toastApiError } from "@/lib/api/client"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { communityWsResetTypingThrottle } from "@/hooks/community/use-community-ws"

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
  const nonce = sendNonce()
  const createdPreviewUrls: string[] = []
  const accepted = useMessageStreamStore.getState().accept(messageScope, {
    nonce,
    tempId: tempMessageId(),
    message: {
      type: "chat",
      authorId: viewer.id,
      authorName: viewer.name,
      authorAvatar: viewer.avatar,
      content: markdown,
      createdAt: new Date().toISOString(),
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
  if (!accepted) {
    for (const url of createdPreviewUrls) URL.revokeObjectURL(url)
    return false
  }
  void runAcceptedIntent(nonce)
  communityWsResetTypingThrottle({ channelId })
  clearReply()
  return true
}
