import { sendNonce, tempMessageId, toAttachmentVm, type SendMessageArgs } from "@/hooks/community/mutations/messages"
import { zipUploadResultsWithDimensions, type UploadFileArgs, type UploadFileResult } from "@/hooks/community/mutations/uploads"
import { toastApiError } from "@/lib/api/client"
import type { CommunityRuntime } from "@/stores/community/runtime"
import type { MessageScope } from "./message-stream"
import type { SendAttachment } from "./models/message"
import { canonicalizeReplyContent } from "./reply-content"
import { toOptimisticReplyPreview } from "./reply-preview"

export function messageSendError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Failed to send message")
}

export function acceptMessageIntent(runtime: CommunityRuntime, scope: MessageScope,
  input: Pick<SendMessageArgs, "content" | "author" | "replyTo" | "nonce" | "mentionType"> & { attachments?: SendAttachment[] },
): string | undefined {
  if (!input.content && !input.attachments?.length) return undefined
  const content = canonicalizeReplyContent(input.content, input.replyTo)
  const nonce = input.nonce ?? sendNonce()
  const createdPreviewUrls: string[] = []
  const accepted = runtime.messageStream.actions.accept(scope, {
    nonce,
    tempId: tempMessageId(),
    message: {
      type: "chat",
      authorId: input.author.id,
      authorName: input.author.name,
      authorAvatar: input.author.avatar,
      content,
      createdAt: new Date().toISOString(),
      ...(input.replyTo ? { replyTo: toOptimisticReplyPreview(input.replyTo) } : {}),
    },
    localUploads: input.attachments?.map((attachment) => {
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
    mentionType: input.mentionType,
  })
  if (!accepted) {
    for (const url of createdPreviewUrls) URL.revokeObjectURL(url)
    return undefined
  }
  return nonce
}

export async function prepareMessageIntent<Target extends UploadFileArgs["target"]>({
  runtime, scope, nonce, assertOwner, assertActive, uploadFileAsync, target,
}: {
  runtime: CommunityRuntime
  scope: MessageScope
  nonce: string
  assertOwner: () => void
  assertActive?: UploadFileArgs["assertActive"]
  target: Target
  uploadFileAsync: (input: Omit<UploadFileArgs, "target"> & { target: Target }) => Promise<UploadFileResult>
}) {
  const assert = () => { assertOwner(); assertActive?.() }
  assert()
  const streamStore = runtime.messageStream.actions
  const payload = streamStore.getRetryPayload(scope, nonce)
  if (!payload) return { ok: false as const, error: new Error("Message intent is no longer available") }
  let uploadedAttachments: UploadFileResult[] | undefined
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
          target,
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
      try { assertOwner() } catch (error) { return { ok: false as const, error: messageSendError(error) } }
      streamStore.dispatch(scope, { type: "uploadFailed", nonce })
      return { ok: false as const, error: new Error("Failed to attach file") }
    }
    uploadedAttachments = zipUploadResultsWithDimensions(
      results as UploadFileResult[],
      [...payload.localUploads],
    )
    try { assert() } catch (error) {
      try { assertOwner(); streamStore.dispatch(scope, { type: "uploadFailed", nonce }) } catch {}
      return { ok: false as const, error: messageSendError(error) }
    }
    streamStore.dispatch(scope, {
      type: "uploadSettled",
      nonce,
      attachments: uploadedAttachments.map((attachment) => toAttachmentVm(scope.id, attachment)),
    })
  }
  return { ok: true as const, payload, attachments: uploadedAttachments }
}
