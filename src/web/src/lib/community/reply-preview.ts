import { truncateMessagePreview } from "@alook/shared"

export function toOptimisticReplyPreview<T extends { text: string }>(reply: T): T {
  return { ...reply, text: truncateMessagePreview(reply.text) }
}
