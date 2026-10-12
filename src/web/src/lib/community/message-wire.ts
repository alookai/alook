import { CommunityLegacyMessageCreateSchema, CommunityMessagePreviewSchema, CommunityMessageResourceSchema, type CommunityMessageCreate, type CommunityMessageResource, type CommunityMessagePreview } from "@alook/shared"
import { MessageEmbedSchema, type Msg, type CanonicalMessage } from "@/lib/community/models/message"
import type { MessageRow } from "./message-payload"
import { avatarInitial } from "@/lib/community/avatar"
import { presentMessageAttachment } from "@/lib/community/attachment-presentation"
import { canonicalUserImage } from "@/lib/community/storage"
import { projectMessageWireType } from "@/lib/community/message-wire-type"

type UiEmbed = NonNullable<Msg["embeds"]>[number]
const richContentSchema = CommunityMessagePreviewSchema.pick({ attachments: true, embeds: true }).strip()

type LegacyPostedMessage = Pick<MessageRow, "id" | "seq" | "createdAt" | "content" | "authorId" | "authorName" | "authorImage" | "authorAvatarVersion" | "type" | "embeds"> & Partial<Pick<CommunityMessageResource, "replyToId" | "replyTo" | "attachments" | "clientNonce">>
export type PostedMessage = LegacyPostedMessage | (CommunityMessageResource & { resourceComplete: true })

function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitUndefined) as T
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)
    .map(([key, field]) => [key, omitUndefined(field)])) as T
}

function projectEmbed(value: unknown): UiEmbed | undefined {
  const parsed = MessageEmbedSchema.safeParse(value)
  return parsed.success ? omitUndefined(parsed.data) : undefined
}

function projectMessageRichContent(value: unknown): Pick<Msg, "attachments" | "embeds"> {
  const { attachments, embeds } = richContentSchema.parse(value)
  return {
    ...(attachments ? { attachments: attachments.map(presentMessageAttachment) } : {}),
    ...(embeds ? { embeds: embeds.flatMap((value) => { const embed = projectEmbed(value); return embed ? [embed] : [] }) } : {}),
  }
}

export function presentCanonicalMessage(message: CommunityMessagePreview): Msg {
  const { channelId: _channelId, replyToId: _replyToId, clientNonce, authorAvatar, attachments: _attachments, embeds: _embeds, thread, ...fields } = message
  return {
    ...fields,
    ...(authorAvatar === undefined ? {} : { authorAvatar: authorAvatar ?? avatarInitial(message.authorName ?? "") }),
    ...(clientNonce != null ? { clientNonce } : {}),
    ...(thread ? { thread: presentMessageThread(thread) } : {}),
    ...projectMessageRichContent(message),
  }
}

function presentMessageThread(thread: NonNullable<CommunityMessagePreview["thread"]>): NonNullable<Msg["thread"]> {
  const { participants, ...fields } = thread
  return { ...fields, name: thread.name ?? "", messageCount: thread.messageCount ?? 0, lastReplyAt: thread.lastReplyAt ?? undefined,
    ...(participants ? { participants: participants.map((participant) => ({
      ...participant, name: participant.name ?? "", avatar: participant.avatar ?? avatarInitial(participant.name ?? ""), avatarVersion: participant.avatarVersion ?? 0,
    })) } : {}),
  }
}

export function projectCommunityMessageCreate(
  message: CommunityMessageCreate["message"],
  channelId: string,
  contract: 1 | 2 | 3 = 2,
): CanonicalMessage {
  if (contract === 3) {
    const full = CommunityMessageResourceSchema.parse(message)
    if (full.channelId !== channelId) throw new Error("Message resource scope mismatch")
    return { ...full, resourceComplete: true }
  }
  const legacy = CommunityLegacyMessageCreateSchema.shape.message.parse(message)
  const attachments = legacy.attachments?.map((attachment) => ({
    id: attachment.id, name: attachment.filename, url: attachment.url,
    contentType: attachment.contentType, sizeBytes: attachment.size,
    thumbnailUrl: attachment.thumbnailUrl, width: attachment.width, height: attachment.height,
  }))
  return projectCanonicalMessage({ ...legacy, attachments }, channelId)
}

function projectCanonicalMessage(value: Record<string, unknown>, channelId: string): CanonicalMessage {
  const message = CommunityMessagePreviewSchema.strip().parse({ ...value, channelId })
  if (typeof message.seq !== "number") throw new Error("Confirmed message sequence missing")
  if (value.channelId !== undefined && value.channelId !== channelId) throw new Error("Message resource scope mismatch")
  const fields = Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined))
  return { ...fields, id: message.id, type: message.type, channelId, seq: message.seq, resourceComplete: false }
}

export function projectPostedMessage(
  message: PostedMessage,
  clientNonce: string,
  channelId: string,
): CanonicalMessage {
  if ("resourceComplete" in message && message.resourceComplete === true) {
    const full = CommunityMessageResourceSchema.strip().parse(message)
    if (full.channelId !== channelId || (clientNonce && full.clientNonce !== clientNonce)) throw new Error("Posted message confirmation mismatch")
    return { ...full, resourceComplete: true }
  }
  if (!("authorImage" in message)) throw new Error("Posted message confirmation missing resource contract")
  const { authorImage, type, content, embeds, ...fields } = message
  return projectCanonicalMessage({
    ...fields,
    ...projectMessageWireType(type),
    authorAvatar: canonicalUserImage(message.authorId, authorImage, message.authorAvatarVersion),
    content: content ?? "",
    embeds: Array.isArray(embeds) ? embeds : undefined,
    ...(clientNonce ? { clientNonce } : {}),
  }, channelId)
}
