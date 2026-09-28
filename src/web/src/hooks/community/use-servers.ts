"use client"

import {
  notifyManager,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { compareAsciiSqliteBinary, UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import type { Server, Category, Channel } from "@/lib/community/models/navigation"
import { getActiveAccountUnreadProjection, type AccountUnreadScope } from "./account-unread-projection"
import { ApiError } from "@/lib/errors"
import { evictServerChannelScopes } from "./community-ws/scope-eviction"
import {
  useAttentionScopes,
  useOptionalCommunityDbRegistry,
  useServerRailProjection,
  useServerTreeProjection,
} from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { ServerRow } from "@/lib/community-db/schema"
import type { ServersResponse as ServerCollectionResponse } from "@/lib/community-db/server-collection"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
} from "@/lib/community-db/sync"

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

function serverRowToServer(row: ServerRow): Server {
  return {
    id: row.id,
    name: row.name,
    discriminator: row.discriminator,
    description: row.description,
    ownerId: row.ownerId,
    initial: avatarInitial(row.name),
    active: false,
    unread: row.unread,
    mentions: row.mentions,
    isOwner: row.isOwner,
    icon: row.icon,
    official: row.official,
  }
}

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

function serverDetailStructureSignature(detail: ServerDetail | null | undefined) {
  if (!detail) return null
  return JSON.stringify(detail.categories
    .map((category) => [
      category.id,
      category.channels
        .map((channel) => [channel.id, channel.type ?? "text"])
        .sort((left, right) => (
          compareAsciiSqliteBinary(left[0]!, right[0]!)
          || compareAsciiSqliteBinary(left[1]!, right[1]!)
        )),
    ] as const)
    .sort((left, right) => compareAsciiSqliteBinary(left[0], right[0])))
}

type ForumUnreadState = Record<string, {
  /** The forum channel's own unread contribution, excluding child posts. */
  baseUnread: boolean
  /** Every canonically unread participating child, loaded in the sidebar or not. */
  childIds: string[]
}>

type RawChannel = Channel & { categoryId: string | null }
async function resolveServerIdentity(
  queryClient: QueryClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<Server | undefined> {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return undefined
  const cached = registry.collections.servers.get(serverId)
  if (cached) return serverRowToServer(cached)
  await registry.ensureCollectionReady("servers")
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  await registry.requestServerRefetch()
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  const fetched = registry.collections.servers.get(serverId)
  return fetched ? serverRowToServer(fetched) : undefined
}

export const serverQueryFn = (
  queryClient: QueryClient,
  serverId: string,
  signal?: AbortSignal,
) => async (): Promise<ServerDetail> => {
  const fetchResource = <T,>(path: string) => signal
    ? apiFetch<T>(path, { signal })
    : apiFetch<T>(path)
  const [server, categoryData, channelData] = await Promise.all([
    resolveServerIdentity(queryClient, serverId, signal),
    fetchResource<{ categories: Array<Omit<Category, "channels"> & { serverId?: string }> }>(`/api/community/servers/${serverId}/categories`),
    fetchResource<{ channels: RawChannel[] }>(`/api/community/servers/${serverId}/channels`),
  ])
  if (!server) throw new Error("server not found")
  const channels = channelData.channels.map((channel) => ({
    ...channel,
    active: false,
    // Visible unread state is projected exclusively from account attention.
    unread: false,
  }))
  const categories: Category[] = categoryData.categories.map((category) => ({
    ...category,
    channels: channels.filter((channel) => channel.categoryId === category.id),
  }))
  const uncategorized = channels.filter((channel) => !channel.categoryId)
  if (uncategorized.length > 0) {
    categories.push({ id: UNCATEGORIZED_CATEGORY_ID, name: "", private: 0, channels: uncategorized })
  }
  return {
    id: server.id,
    name: server.name,
    discriminator: server.discriminator ?? "",
    description: server.description ?? "",
    icon: server.icon ?? null,
    official: server.official === true,
    ownerId: server.ownerId ?? "",
    categories,
  }
}

export const serverProjectedQueryFn = (
  queryClient: QueryClient,
  serverId: string,
  signal?: AbortSignal,
) => async () => {
  const structuralToken = captureCommunityLiveSnapshotToken(queryClient)
  const projection = getActiveAccountUnreadProjection(queryClient)
  const family = `server-detail:${serverId}` as const
  const token = projection.beginSnapshot(family, "channels")
  try {
    const data = await serverQueryFn(queryClient, serverId, signal)()
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, signal)
    const confirmedAccessScopes: AccountUnreadScope[] = [
      { kind: "server", serverId },
      ...data.categories.flatMap((category) => category.channels.map((channel) => ({
        kind: "channel" as const,
        channelId: channel.id,
      }))),
    ]
    projection.absorbSnapshot(
      token,
      [],
      { confirmedAccessScopes },
    )
    await publishCommunityLiveSnapshot(queryClient, {
      snapshot: { kind: "server-detail", data },
      proof: { kind: "structural", token: structuralToken, signal },
    })
    return data
  } catch (error) {
    projection.cancelSnapshot(token)
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      evictServerChannelScopes(queryClient, serverId)
    }
    throw error
  }
}

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
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const enabled = !!serverId
  const queryFn = useMemo(() => {
    if (!serverId) return () => Promise.reject(new Error("disabled"))
    return ({ signal }: QueryFunctionContext = {} as QueryFunctionContext) => (
      serverProjectedQueryFn(queryClient, serverId, signal)()
    )
  }, [queryClient, serverId])
  const query = useQuery({
    queryKey: enabled ? communityKeys.server(serverId!) : communityKeys.server("__none__"),
    queryFn,
    enabled,
    // WS events (member.*, channel/category changes) live-patch this
    // ServerDetail cache, so a remount doesn't need to refetch — this is a
    // once-per-server seed. staleTime: Infinity stops the per-channel-switch
    // refetch; refetchOnReconnect backstops the socket-gap case (the WS
    // reconnect handler does not re-seed server detail).
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  useEffect(() => {
    if (!serverId || !query.data) return
    const family = `server-detail:${serverId}` as const
    if (query.data.unreadSources) {
      unreadProjection.mergeSources(
        family,
        query.data.unreadSources.map((source) => ({ ...source, serverId })),
        "channels",
      )
      return
    }
    unreadProjection.recordLegacySnapshot(
      query.data,
      query.data.categories.flatMap((category) => category.channels.flatMap((channel) => {
        const forum = query.data?.forumUnreadState?.[channel.id]
        if (forum) {
          return [
            ...(forum.baseUnread ? [{
              family,
              channelId: channel.id,
              serverId,
            }] : []),
            ...forum.childIds.map((childId) => ({
              family,
              channelId: childId,
              serverId,
              railChannelId: channel.id,
            })),
          ]
        }
        return channel.unread ? [{ family, channelId: channel.id, serverId }] : []
      })),
    )
  }, [query.data, serverId, unreadProjection])
  const projectedServer = useMemo(() => {
    const source = registry ? dbServer : query.data
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
  }, [attentionScopes, dbServer, query.data, registry, serverId])
  return {
    ...query,
    server: query.error instanceof ApiError
      && (query.error.status === 403 || query.error.status === 404)
      ? null
      : projectedServer,
    // A fresh transport response settles before its non-optimistic canonical
    // transaction becomes visible. Structural equality closes that commit gap
    // for route and sidebar reveal boundaries.
    isLiveAuthoritative: query.data !== undefined
      && serverDetailStructureSignature(query.data)
        === serverDetailStructureSignature(projectedServer),
  }
}
