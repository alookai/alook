"use client"

import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { isServerOwner, UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import type { Server, Category, Channel } from "@/lib/community/models/navigation"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"
import { useInboxProjectionTarget } from "./use-inbox-auto-collapse"
import { reservedUnreadExclusion } from "./unread-presentation"

/**
 * Fetches the sidebar list of servers the current user is in.
 *
 * The API returns raw rows; we transform to the render-ready `Server` shape
 * (with `initial` + `isOwner`) inside the query function so consumers get
 * cache entries that are directly render-usable. `active` is a UI-only flag
 * consumers apply after the fact based on the current-server pointer — it's
 * always `false` in the cache.
 */
type RawServerRow = {
  id: string
  name: string
  discriminator: string
  icon: string | null
  role?: string
  mentions?: number
  unread?: boolean
  description?: string | null
  ownerId: string
  unreadSources?: Array<{ channelId: string; lastUnreadSeq: number }>
  mentionSources?: Array<{ channelId: string; count: number; lastSeq: number }>
}

export type ServersResponse = { servers: Server[] }

// Frozen empty fallback — reused across renders while the query is loading so
// consumers depending on `servers` in a `useEffect` dep array don't re-fire
// per render (a fresh `[]` would churn the reference).
const EMPTY_SERVERS: readonly Server[] = Object.freeze([])

export const serversQueryFn = async (
  context?: QueryFunctionContext,
): Promise<ServersResponse> => {
  const data = await apiFetch<{ servers: RawServerRow[] }>("/api/community/servers", {
    signal: context?.signal,
  })
  const servers: Server[] = data.servers.map((s) => ({
    id: s.id,
    name: s.name,
    discriminator: s.discriminator,
    description: s.description ?? "",
    ownerId: s.ownerId,
    initial: avatarInitial(s.name),
    active: false,
    unread: s.unread ?? false,
    // Defensive fallback: the API always projects `mentions` now, but during
    // rolling deploys or from cached stale responses the field could still be
    // absent — treat it as 0 rather than NaN.
    mentions: s.mentions ?? 0,
    isOwner: isServerOwner(s.role),
    icon: s.icon ?? null,
    ...(s.unreadSources ? { unreadSources: s.unreadSources } : {}),
    ...(s.mentionSources ? { mentionSources: s.mentionSources } : {}),
  }))
  return { servers }
}

function serversQueryOptions() {
  return {
    queryKey: communityKeys.servers(),
    queryFn: serversQueryFn,
    staleTime: Infinity,
  } as const
}

export function useServers(): UseQueryResult<ServersResponse> & {
  servers: Server[]
} {
  const query = useQuery({
    ...serversQueryOptions(),
    // WS-maintained like the other server-scoped queries: server.update
    // live-patches this list (name/icon) and mention/member events invalidate
    // it to refresh counts. So a remount doesn't need to refetch — this is a
    // once-per-session seed. Without this, every channel switch that remounts a
    // `useServers` consumer re-fired `GET /api/community/servers` (the rail /
    // mention-badge list), a per-switch server-level request WS1/WS2 otherwise
    // eliminated. staleTime: Infinity stops that mount refetch; invalidations
    // still force a refresh regardless of staleTime, so counts stay live.
    // refetchOnReconnect backstops the socket-gap case (same as WS2).
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const queryClient = useQueryClient()
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const unreadVersion = useSyncExternalStore(
    unreadProjection.subscribe,
    unreadProjection.getSnapshot,
    unreadProjection.getSnapshot,
  )
  const reservationTarget = useInboxProjectionTarget(queryClient)
  const unreadExclusion = useMemo(
    () => reservedUnreadExclusion(reservationTarget, "channels"),
    [reservationTarget],
  )
  useEffect(() => {
    const sources = query.data?.servers.flatMap((server) => server.unreadSources ?? [])
    if (sources) unreadProjection.absorbFamily("servers", sources)
    if (!query.data) return
    for (const server of query.data.servers) {
      if (server.unreadSources) {
        unreadProjection.absorbLegacyServerAggregate(server.id, server.unreadSources)
      }
    }
    unreadProjection.recordLegacySnapshot(
      query.data,
      query.data.servers.flatMap((server) => (
        server.unread && server.unreadSources === undefined
          ? [{
              family: "servers" as const,
              channelId: `\u0000legacy-server:${server.id}`,
              serverId: server.id,
            }]
          : []
      )),
    )
  }, [query.data, unreadProjection])
  const projectedServers = useMemo(() => {
    void unreadVersion
    const raw = query.data?.servers
    if (!raw) return undefined
    let changed = false
    const projected = raw.map((server) => {
      const unread = unreadProjection.projectServerUnread(
        server.id,
        server.unreadSources ?? [],
        server.unread,
        unreadExclusion,
      )
      const mentions = unreadProjection.projectServerMentionCount(
        server.id,
        server.mentionSources ?? [],
        server.mentions,
      )
      if (unread === server.unread && mentions === server.mentions) return server
      changed = true
      return { ...server, unread, mentions }
    })
    return changed ? projected : raw
  }, [query.data, unreadExclusion, unreadProjection, unreadVersion])
  return {
    ...query,
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

type RawChannel = Channel & { categoryId: string | null }
type UnreadResponse = {
  stale?: boolean
  channelIds: string[]
  sources?: Array<{
    channelId: string
    lastUnreadSeq: number
    lastAttentionSeq: number | null
  }>
  childChannels?: Array<{
    id: string
    parentChannelId: string
    lastUnreadSeq?: number
    lastAttentionSeq?: number | null
  }>
}

async function resolveServerIdentity(
  queryClient: QueryClient,
  serverId: string,
): Promise<Server | undefined> {
  const cached = queryClient
    .getQueryData<ServersResponse>(communityKeys.servers())
    ?.servers.find((server) => server.id === serverId)
  if (cached) return cached

  const fetched = await serversQueryFn()
  return fetched.servers.find((server) => server.id === serverId)
}

export const serverQueryFn = (
  queryClient: QueryClient,
  serverId: string,
) => async (): Promise<ServerDetail> => {
  const [server, categoryData, channelData, unreadData] = await Promise.all([
    resolveServerIdentity(queryClient, serverId),
    apiFetch<{ categories: Array<Omit<Category, "channels"> & { serverId?: string }> }>(`/api/community/servers/${serverId}/categories`),
    apiFetch<{ channels: RawChannel[] }>(`/api/community/servers/${serverId}/channels`),
    apiFetch<UnreadResponse>(`/api/community/servers/${serverId}/unreads`),
  ])
  if (unreadData.stale) throw new Error("stale D1 read")
  if (!server) throw new Error("server not found")
  const unreadIds = new Set(unreadData.channelIds)
  const forumParentIds = new Set(
    channelData.channels.filter((channel) => channel.type === "forum").map((channel) => channel.id),
  )
  const forumUnreadState: ForumUnreadState = Object.fromEntries(
    [...forumParentIds].map((parentChannelId) => [parentChannelId, {
      baseUnread: unreadIds.has(parentChannelId),
      childIds: (unreadData.childChannels ?? [])
        .filter((child) => child.parentChannelId === parentChannelId)
        .map((child) => child.id),
    }]),
  )
  const channels = channelData.channels.map((channel) => {
    const forumUnread = forumUnreadState[channel.id]
    return {
      ...channel,
      active: false,
      // Until the sidebar projection arrives, every canonical unread child is
      // necessarily hidden. Its parent owns the cold-boot fallback dot; the
      // sidebar hook migrates loaded children to their own rows immediately.
      unread: forumUnread
        ? forumUnread.baseUnread || forumUnread.childIds.length > 0
        : unreadIds.has(channel.id),
    }
  })
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
    ownerId: server.ownerId ?? "",
    categories,
    forumUnreadState,
    ...(unreadData.sources ? { unreadSources: unreadData.sources } : {}),
  }
}

/**
 * Fetches the detail (categories + channels) for one server. Pass `null` for
 * "no active server" (including the DM home) — the query stays disabled and
 * no request fires.
 */
export function useServer(
  serverId: string | null,
): UseQueryResult<ServerDetail> & { server: ServerDetail | null } {
  const queryClient = useQueryClient()
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const unreadVersion = useSyncExternalStore(
    unreadProjection.subscribe,
    unreadProjection.getSnapshot,
    unreadProjection.getSnapshot,
  )
  const reservationTarget = useInboxProjectionTarget(queryClient)
  const unreadExclusion = useMemo(
    () => reservedUnreadExclusion(reservationTarget, "channels"),
    [reservationTarget],
  )
  const enabled = !!serverId
  const query = useQuery({
    queryKey: enabled ? communityKeys.server(serverId!) : communityKeys.server("__none__"),
    queryFn: enabled
      ? serverQueryFn(queryClient, serverId!)
      : (() => Promise.reject(new Error("disabled"))),
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
      unreadProjection.absorbFamily(family, query.data.unreadSources)
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
    void unreadVersion
    if (!query.data || !serverId) return null
    const sourceByChannel = new Map(
      (query.data.unreadSources ?? []).map((source) => [source.channelId, source]),
    )
    let changed = false
    const categories = query.data.categories.map((category) => {
      let categoryChanged = false
      const channels = category.channels.map((channel) => {
        const forum = query.data?.forumUnreadState?.[channel.id]
        const sourceIds = forum
          ? [channel.id, ...forum.childIds]
          : [channel.id]
        const sources = sourceIds.flatMap((id) => {
          const source = sourceByChannel.get(id)
          return source ? [source] : []
        })
        const unread = unreadProjection.projectServerChannelUnread(
          serverId,
          channel.id,
          sources,
          channel.unread,
          unreadExclusion,
        )
        if (unread === channel.unread) return channel
        categoryChanged = true
        return { ...channel, unread }
      })
      if (!categoryChanged) return category
      changed = true
      return { ...category, channels }
    })
    return changed ? { ...query.data, categories } : query.data
  }, [query.data, unreadExclusion, serverId, unreadProjection, unreadVersion])
  return {
    ...query,
    server: projectedServer,
  }
}
