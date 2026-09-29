"use client"

import {
  notifyManager,
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import type { Server, Category } from "@/lib/community/models/navigation"
import { ApiError } from "@/lib/errors"
import {
  useAttentionScopes,
  useOptionalCommunityDbRegistry,
  useServerRailProjection,
  useServerTreeProjection,
} from "@/lib/community-db/projections"
import type { ServersResponse as ServerCollectionResponse } from "@/lib/community-db/server-collection"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import {
  createServerDetailResourceQueryFn,
  serverDetailResourceBaseKey,
  serverDetailResourceKey,
} from "@/lib/community-db/server-detail-resource"

export type ServersQueryResult = {
  data: ServerCollectionResponse | undefined
  error: Error | null
  isFetching: boolean
  isPending: boolean
  isSuccess: boolean
  refetch: () => Promise<void>
  servers: Server[]
}

// Frozen empty fallback — reused across renders while the query is loading so
// consumers depending on `servers` in a `useEffect` dep array don't re-fire
// per render (a fresh `[]` would churn the reference).
const EMPTY_SERVERS: readonly Server[] = Object.freeze([])

export function useServers(): ServersQueryResult {
  const registry = useOptionalCommunityDbRegistry()
  const attentionScopes = useAttentionScopes()
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  useSyncExternalStore(
    useCallback(
      (listener) => queryClient.getQueryCache().subscribe(
        notifyManager.batchCalls(listener),
      ),
      [queryClient],
    ),
    useCallback(
      () => queryClient.getQueryState<ServerCollectionResponse>(serversCollectionQueryKey()),
      [queryClient],
    ),
    () => undefined,
  )
  const queryState = queryClient.getQueryState<ServerCollectionResponse>(serversCollectionQueryKey())
  const projectedServers = useMemo(() => {
    const raw = registry ? dbRail?.servers : undefined
    if (!raw) return undefined
    let changed = false
    const projected = raw.map((server) => {
      const serverScopes = attentionScopes.filter((scope) => scope.serverId === server.id)
      const unread = serverScopes.some((scope) => scope.ordinaryUnread)
      const mentions = serverScopes.reduce((total, scope) => total + (scope.attentionCount ?? 0), 0)
      if (unread === server.unread && mentions === server.mentions) return server
      changed = true
      return { ...server, unread, mentions }
    })
    return changed ? projected : raw
  }, [attentionScopes, dbRail?.servers, registry])
  const projectionMatchesSnapshot = useMemo(() => {
    if (!projectedServers || !queryState?.data) return false
    if (projectedServers.length !== queryState.data.servers.length) return false
    const projectedIds = new Set(projectedServers.map((server) => server.id))
    return queryState.data.servers.every((server) => projectedIds.has(server.id))
  }, [projectedServers, queryState?.data])
  const snapshotApplied = queryState?.status === "success"
    && (registry?.isCollectionReady?.("servers") ?? false)
    && projectionMatchesSnapshot
  const refetch = useCallback(
    () => registry?.requestServerRefetch() ?? Promise.resolve(),
    [registry],
  )
  return {
    data: queryState?.data,
    error: queryState?.error instanceof Error ? queryState.error : null,
    isFetching: queryState?.fetchStatus === "fetching" || (
      queryState?.status === "success" && !projectionMatchesSnapshot
    ),
    isPending: queryState?.status !== "success" || !projectionMatchesSnapshot,
    isSuccess: snapshotApplied,
    refetch,
    servers: projectedServers ?? (EMPTY_SERVERS as Server[]),
  }
}

// ── Single-server detail ─────────────────────────────────────────────────────

export type ServerDetail = {
  id: string
  name: string
  discriminator: string
  description: string
  icon: string | null
  official?: boolean
  ownerId: string
  categories: Category[]
  /** Canonical unread ownership for participating children of forum channels. */
  forumUnreadState?: ForumUnreadState
  unreadSources?: Array<{
    channelId: string
    lastUnreadSeq: number
    lastAttentionSeq: number | null
  }>
}

type ForumUnreadState = Record<string, {
  /** The forum channel's own unread contribution, excluding child posts. */
  baseUnread: boolean
  /** Every canonically unread participating child, loaded in the sidebar or not. */
  childIds: string[]
}>

/**
 * Fetches the detail (categories + channels) for one server. Pass `null` for
 * "no active server" (including the DM home) — the query stays disabled and
 * no request fires.
 */
export function useServer(
  serverId: string | null,
): UseQueryResult<ServerDetail> & {
  server: ServerDetail | null
  isLiveAuthoritative: boolean
} {
  const registry = useOptionalCommunityDbRegistry()
  const attentionScopes = useAttentionScopes()
  const dbServer = useServerTreeProjection(serverId)
  const queryClient = useQueryClient()
  const enabled = !!serverId
  const scopeId = registry?.scopeId ?? "anon"
  const queryKey = enabled
    ? serverDetailResourceKey(scopeId, serverId!)
    : [...serverDetailResourceBaseKey(scopeId), "__none__"] as const
  const queryFn = useMemo(() => {
    if (!serverId) return () => Promise.reject(new Error("disabled"))
    const resourceQueryFn = createServerDetailResourceQueryFn(queryClient, scopeId)
    return (context: QueryFunctionContext) => resourceQueryFn(context)
  }, [queryClient, scopeId, serverId])
  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const projectedServer = useMemo(() => {
    const source = dbServer
    if (!source || !serverId) return null
    let changed = false
    const categories = source.categories.map((category) => {
      let categoryChanged = false
      const channels = category.channels.map((channel) => {
        const unread = attentionScopes.some((scope) => (
          scope.serverId === serverId
          && (scope.channelId === channel.id || scope.parentChannelId === channel.id)
          && scope.ordinaryUnread
        ))
        if (unread === channel.unread) return channel
        categoryChanged = true
        return { ...channel, unread }
      })
      if (!categoryChanged) return category
      changed = true
      return { ...category, channels }
    })
    return changed ? { ...source, categories } : source
  }, [attentionScopes, dbServer, serverId])
  useEffect(() => {
    if (!registry || !serverId || query.data === undefined || !dbServer) return
    const server = registry.collections.servers.get(serverId)
    if (server && !server.detailComplete) {
      registry.collections.servers.utils.writeUpdate({ id: serverId, detailComplete: true })
    }
  }, [dbServer, query.data, registry, serverId])
  const result = {
    ...query,
    data: query.data === undefined ? undefined : projectedServer ?? undefined,
    server: query.error instanceof ApiError
      && (query.error.status === 403 || query.error.status === 404)
      ? null
      : projectedServer,
    isLiveAuthoritative: query.data !== undefined && projectedServer !== null,
  }
  return result as unknown as UseQueryResult<ServerDetail> & {
    server: ServerDetail | null
    isLiveAuthoritative: boolean
  }
}
