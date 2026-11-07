import type { CommunityMessagePosted, MentionType, CommunityResourceProfile } from "@alook/shared"
import type { Attachment, Msg } from "./models/message"
import type { UploadFileResult } from "./attachment-upload"
import { presentMessageAttachment } from "./attachment-presentation"
import { attachmentThumbnailUrl, attachmentUrl } from "./storage"

export type OriginalView = (() => void) & { signal: AbortSignal }

// Derive id-addressed URLs so optimistic and canonical attachment views agree.
export function toAttachmentVm(
  channelId: string,
  a: { id: string; filename: string; contentType: string; size: number; hasThumbnail?: boolean; width?: number; height?: number },
): Attachment {
  return presentMessageAttachment({
    name: a.filename, url: attachmentUrl(channelId, a.id), contentType: a.contentType, sizeBytes: a.size,
    ...(a.hasThumbnail ? { thumbnailUrl: attachmentThumbnailUrl(channelId, a.id) } : {}),
    width: a.width, height: a.height,
  })
}

export function tempMessageId(): string {
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

// Mint once per logical send. Reuse it on retries so a lost committed response
// cannot create another message.
export function sendNonce(): string {
  return crypto.randomUUID()
}

export type SendMessageArgs = {
  assertActive?: OriginalView
  assertCommand?: () => void
  serverId: string
  channelId: string
  forumParentChannelId?: string
  content: string
  replyToId?: string
  replyTo?: Msg["replyTo"]
  mentionType?: MentionType
  // Send only the attachment IDs; descriptors also feed the optimistic view.
  attachments?: UploadFileResult[]
  author: { [Field in "id" | "name" | "avatar"]: NonNullable<CommunityResourceProfile[Field]> }
  // Fresh sends omit this; retries pass the failed row's original nonce.
  nonce?: string
}

// A deduped response reconciles the existing committed message as success;
// it must not trigger another send.
export type SendMessageResult = Pick<CommunityMessagePosted, "message" | "profiles" | "relatedMessages"> & { deduped?: boolean }

export type SendDmMessageArgs = Pick<SendMessageArgs, "assertActive" | "assertCommand" | "content" | "replyToId" | "replyTo" | "attachments"> & {
  dmId: string
  nonce: string
}

