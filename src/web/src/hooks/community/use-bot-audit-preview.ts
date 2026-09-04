"use client"

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useBotAuditEventsForBot } from "@/stores/community/ws"
import type { AuditEvent, AuditLogPage } from "./use-bot-audit-log"

const PREVIEW_LIMIT = 10

export function useBotAuditPreview(botId: string | null | undefined) {
  const enabled = Boolean(botId)
  const query = useQuery<AuditLogPage>({
    enabled,
    queryKey: botId
      ? communityKeys.botAuditPreview(botId)
      : ["disabled-bot-audit-preview"],
    queryFn: () => apiFetch<AuditLogPage>(
      `/api/community/bots/${botId}/audit-log?limit=${PREVIEW_LIMIT}`,
    ),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
    staleTime: 30_000,
  })
  const liveEvents = useBotAuditEventsForBot(botId)

  const preview = useMemo(() => {
    const byId = new Map<string, AuditEvent>()
    for (const event of query.data?.events ?? []) byId.set(event.id, event)
    for (const event of liveEvents) {
      byId.set(event.id, {
        id: event.id,
        kind: event.kind,
        payload: event.payload,
        sessionId: event.sessionId ?? null,
        launchId: event.launchId ?? null,
        createdAt: event.createdAt,
      })
    }
    const merged = [...byId.values()]
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0
      })
    return {
      events: merged.slice(0, PREVIEW_LIMIT),
      hasEarlierEvents: Boolean(query.data?.nextCursor) || merged.length > PREVIEW_LIMIT,
    }
  }, [liveEvents, query.data])

  return {
    ...preview,
    isLoading: query.isLoading,
    isError: query.isError,
    isNotFound: query.error instanceof ApiError && query.error.status === 404,
  }
}
