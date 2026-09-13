import {
  stripInlineMarkup,
  truncateMessagePreview,
  type queries,
} from "@alook/shared"

export interface PushNotificationPayload {
  notificationId: string
  title: string
  body: string
  route: {
    notificationId: string
    messageId: string
    targetId: string
  }
}

function bytesToUuid(bytes: Uint8Array): string {
  const value = new Uint8Array(bytes.slice(0, 16))
  value[6] = (value[6]! & 0x0f) | 0x50
  value[8] = (value[8]! & 0x3f) | 0x80
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-")
}

export async function deriveNotificationId(input: {
  messageId: string
  userId: string
}): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify([
    "alook:mobile-push:v1",
    input.userId,
    input.messageId,
  ]))
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  return bytesToUuid(new Uint8Array(digest))
}

function attachmentFallback(contentTypes: Array<string | null>): string {
  if (contentTypes.some((value) => value?.startsWith("image/"))) return "Photo"
  if (contentTypes.some((value) => value?.startsWith("video/"))) return "Video"
  if (contentTypes.some((value) => value?.startsWith("audio/"))) return "Audio"
  if (contentTypes.length > 0) return "Attachment"
  return "New message"
}

export async function buildPushNotificationPayload(
  target: queries.communityNotificationTarget.PushNotificationTarget,
  userId: string,
): Promise<PushNotificationPayload> {
  const notificationId = await deriveNotificationId({
    messageId: target.messageId,
    userId,
  })
  const plainText = stripInlineMarkup(target.content)
    .replace(/\s+/gu, " ")
    .trim()

  return {
    notificationId,
    title: target.authorName.trim() || "Alook",
    body: plainText
      ? truncateMessagePreview(plainText)
      : attachmentFallback(target.attachmentContentTypes),
    route: {
      notificationId,
      messageId: target.messageId,
      targetId: target.channelId,
    },
  }
}
