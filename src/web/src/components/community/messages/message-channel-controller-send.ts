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
import type { CommunityRuntime } from "@/stores/community/runtime"
import { communityWsEndTyping } from "@/hooks/community/use-community-ws"
import { canonicalizeReplyContent } from "@/lib/community/reply-content"

type ChannelMessageScope = {
  kind: "channel"
  id: string
  serverId: string
}

type UploadFile = (input: {
  assertActive?: (() => void) & { signal: AbortSignal }
  target: { channelId: string }
  file: File
  thumbnailBlob?: Blob
  width?: number
  height?: number
}) => Promise<UploadedAttachment>

type SendMessage = (input: {
  assertActive?: (() => void) & { signal: AbortSignal }
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
  runtime,
  assertActive,
  messageScope,
  nonce,
  uploadFileAsync,
  sendMessageAsync,
  channelId,
  forumParentChannelId,
  serverId,
  viewer,
}: {
  runtime: CommunityRuntime
  assertActive?: (() => void) & { signal: AbortSignal }
  messageScope: ChannelMessageScope
  nonce: string
  uploadFileAsync: UploadFile
  sendMessageAsync: SendMessage
  channelId: string
  forumParentChannelId?: string
  serverId: string
  viewer: Viewer
}) {
  const generation = runtime.lifecycle.get().generation
  const assertOwner = () => {
    const state = runtime.lifecycle.get()
    if (!state.active || state.generation !== generation) throw new DOMException("Retired send owner", "AbortError")
  }
  const assert = () => { assertOwner(); assertActive?.() }
  assert()
  const streamStore = runtime.messageStream.actions
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
          assertActive,
          target: { channelId },
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
      try { assertOwner() } catch { return }
      streamStore.dispatch(messageScope, { type: "uploadFailed", nonce })
      return
    }
    uploadedAttachments = zipUploadResultsWithDimensions(
      results as UploadedAttachment[],
      [...payload.localUploads],
    )
    try { assert() } catch { try { assertOwner(); streamStore.dispatch(messageScope, { type: "uploadFailed", nonce }) } catch {} return }
    streamStore.dispatch(messageScope, {
      type: "uploadSettled",
      nonce,
      attachments: uploadedAttachments.map((attachment) => toAttachmentVm(channelId, attachment)),
    })
  }
  try {
    assert()
    await sendMessageAsync({
      assertActive,
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
    try { assertOwner(); streamStore.dispatch(messageScope, { type: "postFail", nonce }) } catch {}
    return
  }
}

export function acceptChannelMessage({
  runtime,
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
  runtime: CommunityRuntime
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
  const createdPreviewUrls: string[] = []
  const accepted = runtime.messageStream.actions.accept(messageScope, {
    nonce,
    tempId: tempMessageId(),
    message: {
      type: "chat",
      authorId: viewer.id,
      authorName: viewer.name,
      authorAvatar: viewer.avatar,
      content,
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
  communityWsEndTyping(runtime, { channelId })
  clearReply()
  return true
}
