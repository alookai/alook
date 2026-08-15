import type { CommunityMessageCreate } from "@alook/shared"
import type { Msg } from "@/lib/community/models/message"
import { avatarInitial } from "@/lib/community/avatar"
import { isInlineAttachmentContentType } from "@/lib/community/attachment-content-type"
import { formatAttachmentSize } from "@/lib/community/attachment-presentation"
import type { CanonicalMessage } from "@/lib/community/message-stream"

type UiEmbed = NonNullable<Msg["embeds"]>[number]

export type PostedMessage = {
  id: string
  seq: number
  createdAt: string
  content: string | null
  authorId: string
  authorName: string
  authorImage: string | null
  type: string | null
  embeds: unknown
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function projectEmbed(value: unknown): UiEmbed | undefined {
  const input = objectValue(value)
  const title = stringValue(input?.title)
  if (!input || title === undefined) return undefined
  const imageInput = objectValue(input.image)
  const imageUrl = stringValue(imageInput?.url)
  const thumbnailInput = objectValue(input.thumbnail)
  const thumbnailUrl = stringValue(thumbnailInput?.url)
  const footerInput = objectValue(input.footer)
  const footerText = stringValue(footerInput?.text)
  const authorInput = objectValue(input.author)
  const authorName = stringValue(authorInput?.name)
  const fields = Array.isArray(input.fields)
    ? input.fields.flatMap((field) => {
      const row = objectValue(field)
      const name = stringValue(row?.name)
      const fieldValue = stringValue(row?.value)
      if (name === undefined || fieldValue === undefined) return []
      return [{
        name,
        value: fieldValue,
        ...(typeof row?.inline === "boolean" ? { inline: row.inline } : {}),
      }]
    })
    : undefined
  return {
    title,
    ...(stringValue(input.provider) !== undefined ? { provider: stringValue(input.provider) } : {}),
    ...(stringValue(input.url) !== undefined ? { url: stringValue(input.url) } : {}),
    ...(stringValue(input.desc) !== undefined ? { desc: stringValue(input.desc) } : {}),
    ...(stringValue(input.color) !== undefined ? { color: stringValue(input.color) } : {}),
    ...(imageUrl !== undefined ? {
      image: {
        url: imageUrl,
        ...(numberValue(imageInput?.width) !== undefined ? { width: numberValue(imageInput?.width) } : {}),
        ...(numberValue(imageInput?.height) !== undefined ? { height: numberValue(imageInput?.height) } : {}),
      },
    } : {}),
    ...(thumbnailUrl !== undefined ? { thumbnail: { url: thumbnailUrl } } : {}),
    ...(fields?.length ? { fields } : {}),
    ...(footerText !== undefined ? {
      footer: {
        text: footerText,
        ...(stringValue(footerInput?.iconUrl) !== undefined ? { iconUrl: stringValue(footerInput?.iconUrl) } : {}),
      },
    } : {}),
    ...(authorName !== undefined ? {
      author: {
        name: authorName,
        ...(stringValue(authorInput?.url) !== undefined ? { url: stringValue(authorInput?.url) } : {}),
        ...(stringValue(authorInput?.iconUrl) !== undefined ? { iconUrl: stringValue(authorInput?.iconUrl) } : {}),
      },
    } : {}),
  }
}

export function projectCommunityMessageCreate(
  message: CommunityMessageCreate["message"],
): CanonicalMessage {
  const attachments = message.attachments?.map((attachment) => {
    if (isInlineAttachmentContentType(attachment.contentType)) {
      return {
        kind: "image" as const,
        name: attachment.filename,
        url: attachment.url,
        contentType: attachment.contentType,
        sizeBytes: attachment.size,
        ...(attachment.thumbnailUrl ? { thumbnailUrl: attachment.thumbnailUrl } : {}),
        width: attachment.width ?? undefined,
        height: attachment.height ?? undefined,
      }
    }
    return {
      kind: "file" as const,
      name: attachment.filename,
      url: attachment.url,
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      size: formatAttachmentSize(attachment.size),
    }
  })
  const embeds = message.embeds?.flatMap((embed) => {
    const projected = projectEmbed(embed)
    return projected ? [projected] : []
  })
  return {
    id: message.id,
    seq: message.seq,
    type: message.type,
    ...(message.systemKind ? { systemKind: message.systemKind } : {}),
    authorId: message.authorId,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar || avatarInitial(message.authorName),
    content: message.content,
    createdAt: message.createdAt,
    ...(message.clientNonce ? { clientNonce: message.clientNonce } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.approval ? { approval: message.approval } : {}),
    ...(embeds?.length ? { embeds } : {}),
    ...(attachments?.length ? { attachments } : {}),
  }
}

export function projectPostedMessage(
  message: PostedMessage,
  clientNonce: string,
): CanonicalMessage {
  const embeds = Array.isArray(message.embeds)
    ? message.embeds.flatMap((embed) => {
      const projected = projectEmbed(embed)
      return projected ? [projected] : []
    })
    : undefined
  const type = message.type === "thread_created"
    ? { type: "system" as const, systemKind: "thread" as const }
    : message.type === "system"
      ? { type: "system" as const }
      : { type: "chat" as const }
  return {
    id: message.id,
    seq: message.seq,
    ...type,
    authorId: message.authorId,
    authorName: message.authorName,
    authorAvatar: message.authorImage || avatarInitial(message.authorName),
    content: message.content ?? "",
    createdAt: message.createdAt,
    clientNonce,
    ...(embeds?.length ? { embeds } : {}),
  }
}
