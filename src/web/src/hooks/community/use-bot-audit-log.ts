"use client"
import { fetchBotDirectory } from "@/lib/community/bot-directory-read"

import { useMemo } from "react"
import {
useInfiniteQuery,
useQueryClient,
replaceEqualDeep,
type InfiniteData,
type QueryClient,
type QueryKey,
} from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"

import { compareAuditEventsNewestFirst, type AuditEvent, type AuditLogPage } from "@/lib/community/models/audit"
export type { AuditEvent, AuditLogPage } from "@/lib/community/models/audit"

const PAGE_SIZE = 50
export const UNOBSERVED_AUDIT_HEAD_LIMIT = 200


function reconcileAuditLogPages(previous: unknown, incoming: unknown, unobserved = false) {
  const prev = previous as InfiniteData<AuditLogPage> | undefined
  const next = incoming as InfiniteData<AuditLogPage> | undefined
  if (!next?.pages[0]) return replaceEqualDeep(previous, incoming)
  const incomingLive = new Set(next.pages[0].liveIds)
  const confirmed = new Set(next.pages.flatMap((page) => page.events.filter((event) => !incomingLive.has(event.id)).map((event) => event.id)))
  const liveIds = new Set([...(prev?.pages[0]?.liveIds ?? []), ...incomingLive].filter((id) => !confirmed.has(id)))
  const rows = new Map(next.pages[0].events.map((event) => [event.id, event]))
  const laterPageIds = new Set(next.pages.slice(1).flatMap((page) => page.events.map((event) => event.id)))
  for (const event of prev?.pages[0]?.events ?? []) if (liveIds.has(event.id) && !rows.has(event.id) && !laterPageIds.has(event.id)) rows.set(event.id, event)
  const ordered = [...rows.values()].sort(compareAuditEventsNewestFirst)
  const events = unobserved ? ordered.slice(0, UNOBSERVED_AUDIT_HEAD_LIMIT) : ordered
  const retained = new Set(events.map((event) => event.id))
  const [first, ...rest] = next.pages
  return replaceEqualDeep(previous, { ...next, pages: [{ ...first, events, liveIds: [...liveIds].filter((id) => retained.has(id)) }, ...rest] })
}

export function appendBotAuditEvent(queryClient: QueryClient, botId: string, row: AuditEvent) {
  appendAuditEventsToCache(queryClient, communityKeys.botAuditLog(botId), [row])
  const previewKey = communityKeys.botAuditPreview(botId)
  if (row.kind === "text" && queryClient.getQueryState(previewKey)) appendAuditEventsToCache(queryClient, previewKey, [row])
}

function appendAuditEventsToCache(queryClient: QueryClient, key: QueryKey, rows: readonly AuditEvent[]) {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  const updatedAt = query?.state.dataUpdatedAt ?? 0
  const unobserved = !query?.getObserversCount()
  let truncated = false
  queryClient.setQueryData<InfiniteData<AuditLogPage>>(key, (cache) => {
    const [first, ...rest] = cache?.pages ?? []
    const previousRows = first?.events ?? []
    const byId = new Map(previousRows.map((event) => [event.id, event]))
    const added: string[] = []
    for (const row of rows) {
      const existing = byId.get(row.id)
      if (existing && compareAuditEventsNewestFirst(existing, row) <= 0) continue
      byId.set(row.id, row)
      added.push(row.id)
    }
    if (!added.length) return cache
    const ordered = [...byId.values()].sort(compareAuditEventsNewestFirst)
    truncated = unobserved && ordered.length > UNOBSERVED_AUDIT_HEAD_LIMIT
    const events = truncated ? ordered.slice(0, UNOBSERVED_AUDIT_HEAD_LIMIT) : ordered
    const retained = new Set(events.map((event) => event.id))
    const liveIds = [...new Set([...added, ...(first?.liveIds ?? [])])].filter((id) => retained.has(id))
    return { pages: [{ ...first, events, nextCursor: first?.nextCursor ?? null, liveIds }, ...rest], pageParams: cache?.pageParams ?? [null] }
  }, { updatedAt })
  if (truncated) {
    void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" })
  }
}

export function useBotAuditLog(botId: string | null | undefined, textOnly = false) {
  const enabled = Boolean(botId)
  const qc = useQueryClient()
  const queryKey = botId ? (textOnly ? communityKeys.botAuditPreview(botId) : communityKeys.botAuditLog(botId)) : ["disabled-bot-audit-log"]

  const query = useInfiniteQuery<AuditLogPage>({
    enabled,
    queryKey,
    structuralSharing: (prev, next) => reconcileAuditLogPages(prev, next, !qc.getQueryCache().find({ queryKey, exact: true })?.getObserversCount()),
    initialPageParam: null as AuditLogPage["nextCursor"],
    queryFn: async (context) => {
      const resource = qc.getQueryCache().find({ queryKey, exact: true })
      const { pageParam } = context
      const cursor = pageParam as AuditLogPage["nextCursor"]
      const search = new URLSearchParams()
      search.set("limit", String(textOnly ? 10 : PAGE_SIZE))
      if (textOnly) search.set("kind", "text")
      if (cursor) {
        search.set("beforeCreatedAt", cursor.beforeCreatedAt)
        search.set("beforeId", cursor.beforeId)
      }
      const page = { ...await fetchBotDirectory<AuditLogPage>(context, `/api/community/bots/${botId}/audit-log?${search.toString()}`), authoritative: true }
      if (context.signal.aborted || resource && qc.getQueryCache().find({ queryKey, exact: true }) !== resource) throw new DOMException("Retired activity read", "AbortError")
      if (cursor) return page
      const retained = qc.getQueryData<InfiniteData<AuditLogPage>>(queryKey)
      if (retained?.pages.length) {
        const known = new Set(retained.pages.flatMap(previous => previous.events.map(event => event.id)))
        const added = page.events.filter(event => !known.has(event.id))
        if (added.length) appendAuditEventsToCache(qc, queryKey, added)
      }
      const fetchedIds = new Set(page.events.map((event) => event.id))
      const current = qc.getQueryData<InfiniteData<AuditLogPage>>(queryKey)?.pages[0]
      const liveIds = new Set(current?.liveIds)
      const arrived = current?.events.filter((event) => liveIds.has(event.id) && !fetchedIds.has(event.id)) ?? []
      return arrived.length ? { ...page, events: [...arrived, ...page.events], liveIds: arrived.map((event) => event.id) } : page
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
    staleTime: 30_000,
    getNextPageParam: (last) => last.nextCursor,
  })

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
    error: query.error,
    isError: query.isError,
    refetch: query.refetch,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    loadedPageCount: query.data?.pages.length ?? 0,
    hasData: query.data !== undefined,
  }
}
