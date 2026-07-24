"use client"

import { useEffect, useMemo } from "react"
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { useBotAuditEventsForBot } from "@/stores/community/ws"

export type AuditKind = "cli_invocation" | "tool_call" | "thinking" | "wake_trigger" | "session_reset"

export type AuditEvent = {
  id: string
  kind: AuditKind
  payload: unknown
  sessionId: string | null
  launchId: string | null
  createdAt: string
}

export type AuditLogPage = {
  events: AuditEvent[]
  nextCursor: { beforeCreatedAt: string; beforeId: string } | null
}

const PAGE_SIZE = 50

/**
 * React Query infinite hook for a bot's audit log. Live events from the
 * WS store (`useBotAuditEventsForBot`) are prepended into the first page —
 * de-duplicated by `event.id` across ALL cached pages so an event that also
 * arrives via the initial GET (which raced the WS push) is not rendered
 * twice.
 */
export function useBotAuditLog(botId: string | null | undefined) {
  const enabled = Boolean(botId)
  const qc = useQueryClient()

  const query = useInfiniteQuery<AuditLogPage>({
    enabled,
    queryKey: botId ? communityKeys.botAuditLog(botId) : ["disabled-bot-audit-log"],
    initialPageParam: null as AuditLogPage["nextCursor"],
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as AuditLogPage["nextCursor"]
      const search = new URLSearchParams()
      search.set("limit", String(PAGE_SIZE))
      if (cursor) {
        search.set("beforeCreatedAt", cursor.beforeCreatedAt)
        search.set("beforeId", cursor.beforeId)
      }
      return apiFetch<AuditLogPage>(
        `/api/community/bots/${botId}/audit-log?${search.toString()}`,
      )
    },
    getNextPageParam: (last) => last.nextCursor,
  })

  const liveEvents = useBotAuditEventsForBot(botId)

  // Fold live events into the first-page cache. Dedup on `event.id` across
  // ALL pages — the initial GET can race a WS push and land the same row in
  // both channels. Depend on `query.data` too: a live event that lands while
  // the initial GET is still in flight would otherwise see `prev === undefined`
  // and silently drop.
  useEffect(() => {
    if (!enabled || liveEvents.length === 0) return
    qc.setQueryData<InfiniteData<AuditLogPage>>(
      communityKeys.botAuditLog(botId as string),
      (prev) => {
        if (!prev || prev.pages.length === 0) return prev
        const seen = new Set<string>()
        for (const p of prev.pages) for (const e of p.events) seen.add(e.id)
        const fresh: AuditEvent[] = liveEvents
          .filter((e) => !seen.has(e.id))
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            payload: e.payload,
            sessionId: e.sessionId ?? null,
            launchId: e.launchId ?? null,
            createdAt: e.createdAt,
          }))
        if (fresh.length === 0) return prev
        const [firstPage, ...rest] = prev.pages
        const merged: AuditLogPage = {
          nextCursor: firstPage.nextCursor,
          events: [...fresh, ...firstPage.events],
        }
        return { ...prev, pages: [merged, ...rest] }
      },
    )
  }, [botId, enabled, liveEvents, qc, query.data])

  // Flatten pages and dedup by id. The WS-prepend effect above dedups fresh
  // live events against ALL cached pages before writing them into page 1,
  // so on paper duplicates can't leak into the flattened array. In practice
  // they can — a prepended live event on page 1 whose id later appears in a
  // just-fetched older page 2 (the cursor race, when the daemon's
  // server-stamped `createdAt` is close to the page-1 boundary), or a page
  // re-fetch that overlaps at the seam. Dedup here so React never sees two
  // rows with the same key. Keep first occurrence (page order = newest-first).
  const events = useMemo(() => {
    if (!query.data) return [] as AuditEvent[]
    const seen = new Set<string>()
    const out: AuditEvent[] = []
    for (const p of query.data.pages) {
      for (const e of p.events) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        out.push(e)
      }
    }
    return out
  }, [query.data])

  return {
    events,
    isLoading: query.isLoading,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  }
}

