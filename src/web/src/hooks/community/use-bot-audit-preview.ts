"use client"

import { ApiError } from "@/lib/errors"
import { useBotAuditLog } from "./use-bot-audit-log"

const PREVIEW_LIMIT = 10

export function useBotAuditPreview(botId: string | null | undefined, textOnly = false) {
  const query = useBotAuditLog(botId, textOnly)
  const events = textOnly ? query.events.filter((event) => event.kind === "text") : query.events
  return {
    events: events.slice(0, PREVIEW_LIMIT),
    hasEarlierEvents: events.length > PREVIEW_LIMIT || Boolean(query.hasNextPage),
    isLoading: query.isLoading,
    isError: query.isError,
    isNotFound: query.error instanceof ApiError && query.error.status === 404,
  }
}
