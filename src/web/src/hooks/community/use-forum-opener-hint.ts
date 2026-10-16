"use client"

import { useMessage } from "./use-message"

export function useForumOpenerHint(serverId: string, messageId: string | null | undefined, enabled: boolean) {
  const query = useMessage(enabled ? messageId : null, { serverId })
  const message = query.message
  const data = message && typeof message.content === "string" ? {
    id: message.id, content: message.content, ...(message.seq === undefined ? {} : { seq: message.seq }),
  } : undefined
  return { ...query, data, isLoading: query.isLoading && data === undefined }
}
