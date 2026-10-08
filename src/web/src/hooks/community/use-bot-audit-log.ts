"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import { useMemo } from "react"
import {
useInfiniteQuery,
useQueryClient,
replaceEqualDeep,
type InfiniteData,
type QueryClient,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"

export type AuditKind = "cli_invocation" | "tool_call" | "thinking" | "turn_interrupt" | "wake_trigger" | "session_reset" | "nap" | "model_changed" | "provider_changed" | "error"

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
  liveIds?: string[]
}

const PAGE_SIZE = 50
export const UNOBSERVED_AUDIT_HEAD_LIMIT = 200

const auditOrder = (a: AuditEvent, b: AuditEvent) => a.createdAt === b.createdAt ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0) : (a.createdAt > b.createdAt ? -1 : 1)

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
  const ordered = [...rows.values()].sort(auditOrder)
  const events = unobserved ? ordered.slice(0, UNOBSERVED_AUDIT_HEAD_LIMIT) : ordered
  const retained = new Set(events.map((event) => event.id))
  const [first, ...rest] = next.pages
  return replaceEqualDeep(previous, { ...next, pages: [{ ...first, events, liveIds: [...liveIds].filter((id) => retained.has(id)) }, ...rest] })
}

export function appendBotAuditEvent(queryClient: QueryClient, botId: string, row: AuditEvent) {
  const key = communityKeys.botAuditLog(botId)
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  const updatedAt = query?.state.dataUpdatedAt ?? 0
  const unobserved = !query?.getObserversCount()
  let truncated = false
  queryClient.setQueryData<InfiniteData<AuditLogPage>>(key, (cache) => {
    const [first, ...rest] = cache?.pages ?? []
    const previousRows = first?.events ?? []
    const byId = new Map(previousRows.map((event) => [event.id, event]))
    const existing = byId.get(row.id)
    if (existing && auditOrder(existing, row) <= 0) return cache
    byId.set(row.id, row)
    const ordered = [...byId.values()].sort(auditOrder)
    truncated = unobserved && ordered.length > UNOBSERVED_AUDIT_HEAD_LIMIT
    const events = truncated ? ordered.slice(0, UNOBSERVED_AUDIT_HEAD_LIMIT) : ordered
    const retained = new Set(events.map((event) => event.id))
    const liveIds = [...new Set([row.id, ...(first?.liveIds ?? [])])].filter((id) => retained.has(id))
    return { pages: [{ ...first, events, nextCursor: first?.nextCursor ?? null, liveIds }, ...rest], pageParams: cache?.pageParams ?? [null] }
  }, { updatedAt })
  if (truncated) {
    void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" })
  }
}

export function useBotAuditLog(botId: string | null | undefined) {
  const enabled = Boolean(botId)
  const qc = useQueryClient()

  const query = useInfiniteQuery<AuditLogPage>({
    enabled,
    queryKey: botId ? communityKeys.botAuditLog(botId) : ["disabled-bot-audit-log"],
    structuralSharing: (prev, next) => reconcileAuditLogPages(prev, next, !qc.getQueryCache().find({ queryKey: communityKeys.botAuditLog(botId!), exact: true })?.getObserversCount()),
    initialPageParam: null as AuditLogPage["nextCursor"],
    queryFn: async ({ pageParam, signal }) => {
      const token = captureCommunityLiveSnapshotToken(qc)
      const cursor = pageParam as AuditLogPage["nextCursor"]
      const search = new URLSearchParams()
      search.set("limit", String(PAGE_SIZE))
      if (cursor) {
        search.set("beforeCreatedAt", cursor.beforeCreatedAt)
        search.set("beforeId", cursor.beforeId)
      }
      const page = await apiFetch<AuditLogPage>(
        `/api/community/bots/${botId}/audit-log?${search.toString()}`,
        communityRequestOptions(qc, token, signal),
      )
      if (cursor) return page
      const fetchedIds = new Set(page.events.map((event) => event.id))
      const current = qc.getQueryData<InfiniteData<AuditLogPage>>(communityKeys.botAuditLog(botId!))?.pages[0]
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
    isLoading: query.isLoading,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    loadedPageCount: query.data?.pages.length ?? 0,
  }
}
