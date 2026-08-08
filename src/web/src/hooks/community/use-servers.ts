"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { isServerOwner, UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import type { Server, Category, Channel } from "@/components/community/_types"

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
  description?: string | null
  ownerId: string
}

export type ServersResponse = { servers: Server[] }

// Frozen empty fallback — reused across renders while the query is loading so
// consumers depending on `servers` in a `useEffect` dep array don't re-fire
// per render (a fresh `[]` would churn the reference).
const EMPTY_SERVERS: readonly Server[] = Object.freeze([])

export const serversQueryFn = async (): Promise<ServersResponse> => {
  const data = await apiFetch<{ servers: RawServerRow[] }>("/api/community/servers")
  const servers: Server[] = data.servers.map((s) => ({
    id: s.id,
    name: s.name,
    discriminator: s.discriminator,
    initial: avatarInitial(s.name),
    active: false,
    // Defensive fallback: the API always projects `mentions` now, but during
    // rolling deploys or from cached stale responses the field could still be
    // absent — treat it as 0 rather than NaN.
    mentions: s.mentions ?? 0,
    isOwner: isServerOwner(s.role),
    icon: s.icon ?? null,
  }))
  return { servers }
}

export function useServers(): UseQueryResult<ServersResponse> & {
  servers: Server[]
} {
  const query = useQuery({
    queryKey: communityKeys.servers(),
    queryFn: serversQueryFn,
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
  return {
    ...query,
    servers: query.data?.servers ?? (EMPTY_SERVERS as Server[]),
  }
}

// ── Single-server detail ─────────────────────────────────────────────────────

export type ServerDetail = {
  id: string
  name: string
  description: string
  icon: string | null
  ownerId: string
  categories: Category[]
  /** Canonical unread ownership for participating children of forum channels. */
  forumUnreadState?: ForumUnreadState
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
  childChannels?: Array<{ id: string; parentChannelId: string }>
}

export const serverQueryFn = (serverId: string) => async (): Promise<ServerDetail> => {
  const [serverData, categoryData, channelData, unreadData] = await Promise.all([
    apiFetch<{ servers: RawServerRow[] }>("/api/community/servers"),
    apiFetch<{ categories: Array<Omit<Category, "channels"> & { serverId?: string }> }>(`/api/community/servers/${serverId}/categories`),
    apiFetch<{ channels: RawChannel[] }>(`/api/community/servers/${serverId}/channels`),
    apiFetch<UnreadResponse>(`/api/community/servers/${serverId}/unreads`),
  ])
  if (unreadData.stale) throw new Error("stale D1 read")
  const server = serverData.servers.find((row) => row.id === serverId)
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
    description: server.description ?? "",
    icon: server.icon,
    ownerId: server.ownerId,
    categories,
    forumUnreadState,
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
  const enabled = !!serverId
  const query = useQuery({
    queryKey: enabled ? communityKeys.server(serverId!) : communityKeys.server("__none__"),
    queryFn: enabled ? serverQueryFn(serverId!) : (() => Promise.reject(new Error("disabled"))),
    enabled,
    // WS events (member.*, channel/category changes) live-patch this
    // ServerDetail cache, so a remount doesn't need to refetch — this is a
    // once-per-server seed. staleTime: Infinity stops the per-channel-switch
    // refetch; refetchOnReconnect backstops the socket-gap case (the WS
    // reconnect handler does not re-seed server detail).
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  return {
    ...query,
    server: query.data ?? null,
  }
}
