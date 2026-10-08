import { normalizeCommunityMessageResource, CommunityMessageResourceSchema, type CommunityMessageCreate } from "@alook/shared"
import { MessageEmbedSchema, type Msg } from "@/lib/community/models/message"
import type { MessageRow } from "./message-payload"
import { avatarInitial } from "@/lib/community/avatar"
import { presentMessageAttachment } from "@/lib/community/attachment-presentation"
import type { CanonicalMessage } from "@/lib/community/message-stream"
import { canonicalUserImage } from "@/lib/community/storage"
import { projectMessageWireType } from "@/lib/community/message-wire-type"

type UiEmbed = NonNullable<Msg["embeds"]>[number]
const richContentSchema = CommunityMessageResourceSchema.pick({ attachments: true, embeds: true }).partial().strip()

export type PostedMessage = Pick<MessageRow, "id" | "seq" | "createdAt" | "content" | "authorId" | "authorName" | "authorImage" | "authorAvatarVersion" | "type" | "embeds">

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

export function projectMessageRichContent(value: unknown): Pick<Msg, "attachments" | "embeds"> {
  const { attachments, embeds } = richContentSchema.parse(value)
  return {
    ...(attachments ? { attachments: attachments.map(presentMessageAttachment) } : {}),
    ...(embeds ? { embeds: embeds.flatMap((value) => { const embed = projectEmbed(value); return embed ? [embed] : [] }) } : {}),
  }
}

export function projectCommunityMessageCreate(
  message: CommunityMessageCreate["message"],
  channelId: string,
): CanonicalMessage {
  const attachments = message.attachments?.map((attachment) => presentMessageAttachment({
    name: attachment.filename, url: attachment.url, contentType: attachment.contentType,
    sizeBytes: attachment.size,
    ...(attachment.thumbnailUrl ? { thumbnailUrl: attachment.thumbnailUrl } : {}),
    width: attachment.width ?? undefined, height: attachment.height ?? undefined,
  }))
  return projectCanonicalMessage({
    ...message,
    authorAvatar: message.authorAvatar || avatarInitial(message.authorName),
    attachments,
  }, channelId)
}

function projectCanonicalMessage(value: Record<string, unknown>, channelId: string): CanonicalMessage {
  const { channelId: _channelId, replyToId: _replyToId, clientNonce, attachments: _attachments, embeds: _embeds, ...message } = normalizeCommunityMessageResource(value, channelId)
  const { attachments, embeds } = projectMessageRichContent({ attachments: _attachments, embeds: _embeds })
  return {
    ...message,
    ...(clientNonce !== null ? { clientNonce } : {}),
    ...(value.attachments !== undefined ? { attachments } : {}),
    ...(value.embeds != null ? { embeds } : {}),
  }
}

export function projectPostedMessage(
  message: PostedMessage,
  clientNonce: string,
  channelId: string,
): CanonicalMessage {
  const { authorImage, type, content, embeds, ...fields } = message
  return projectCanonicalMessage({
    ...fields,
    ...projectMessageWireType(type),
    authorAvatar: canonicalUserImage(message.authorId, authorImage, message.authorAvatarVersion) || avatarInitial(message.authorName),
    content: content ?? "",
    embeds: Array.isArray(embeds) ? embeds : undefined,
    clientNonce,
  }, channelId)
}
