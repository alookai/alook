"use client"

import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
  type DehydratedState,
} from "@tanstack/react-query"
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { isServerOwner, UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import type { Server, Category, Channel } from "@/lib/community/models/navigation"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadProjection,
  type AccountUnreadScope,
  type AccountUnreadSource,
} from "./account-unread-projection"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ApiError } from "@/lib/errors"
import { evictServerChannelScopes } from "./community-ws/scope-eviction"
import {
  useAttentionScopes,
  useOptionalCommunityDbRegistry,
  useServerRailProjection,
  useServerTreeProjection,
} from "@/lib/community-db/projections"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
  publishCommunityChannelMetadata,
  type CommunityLiveSnapshotToken,
} from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelSchema, serverSchema } from "@/lib/community-db/schema"
import { fetchChannelMetadata } from "./channel-metadata"
import { dmsProjectedQueryFn } from "./use-dms"

type LiveServerListAuthority = CommunityLiveSnapshotToken & {
  serverIdsSignature: string
}

const liveServerListAuthority = new WeakMap<QueryClient, LiveServerListAuthority>()

function canonicalServerIdsSignature(servers: readonly Pick<Server, "id">[]) {
  return JSON.stringify([...new Set(servers.map((server) => server.id))].sort())
}

function currentStructuralQueryGeneration() {
  const state = useCommunityWsStore.getState()
  return `${state.profileViewerId ?? ""}:${state.profileAccountEpoch}:${state.accessEpoch}`
}

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
  official?: boolean
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
    official: s.official === true,
    ...(s.unreadSources ? { unreadSources: s.unreadSources } : {}),
    ...(s.mentionSources ? { mentionSources: s.mentionSources } : {}),
  }))
  return { servers }
}

function serverListUnreadSources(data: ServersResponse): AccountUnreadSource[] {
  return data.servers.flatMap((server) => (
    [
      ...(server.unreadSources ?? []).map((source) => ({
        ...source,
        serverId: server.id,
      })),
      ...(server.mentionSources ?? []).flatMap((source) => source.count > 0 ? [{
        channelId: source.channelId,
        serverId: server.id,
        lastUnreadSeq: source.lastSeq,
        lastMentionSeq: source.lastSeq,
        isMention: true,
      }] : []),
    ]
  ))
}

export const serversProjectedQueryFn = (
  projection: AccountUnreadProjection,
  queryClient: QueryClient,
  onLiveSuccess?: (
    token: CommunityLiveSnapshotToken,
    data: ServersResponse,
    signal: AbortSignal | undefined,
  ) => void,
) => async (context?: QueryFunctionContext) => {
  const structuralToken = captureCommunityLiveSnapshotToken(queryClient)
  const token = projection.beginSnapshot("servers", "channels")
  try {
    const data = await serversQueryFn(context)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
    projection.absorbSnapshot(token, serverListUnreadSources(data), {
      confirmedAccessScopes: data.servers.map((server) => ({
        kind: "server" as const,
        serverId: server.id,
      })),
    })
    onLiveSuccess?.(structuralToken, data, context?.signal)
    return data
  } catch (error) {
    projection.cancelSnapshot(token)
    throw error
  }
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
  isLiveAuthoritative: boolean
} {
  const registry = useOptionalCommunityDbRegistry()
  const attentionScopes = useAttentionScopes()
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  const structuralGeneration = useSyncExternalStore(
    useCommunityWsStore.subscribe,
    currentStructuralQueryGeneration,
    currentStructuralQueryGeneration,
  )
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const unreadVersion = useSyncExternalStore(
    unreadProjection.subscribe,
    unreadProjection.getSnapshot,
    unreadProjection.getSnapshot,
  )
  const queryFn = useMemo(
    () => serversProjectedQueryFn(unreadProjection, queryClient, (token, data, signal) => {
      publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "servers", data },
        proof: { kind: "structural", token, signal },
      })
      liveServerListAuthority.set(queryClient, {
        ...token,
        serverIdsSignature: canonicalServerIdsSignature(data.servers),
      })
    }),
    [queryClient, unreadProjection],
  )
  const query = useQuery({
    ...serversQueryOptions(),
    queryFn,
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
  useEffect(() => {
    if (query.data) {
      unreadProjection.mergeSources(
        "servers",
        serverListUnreadSources(query.data),
        "channels",
      )
    }
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
    const raw = registry
      ? dbRail?.servers.filter((server) => unreadProjection.allowsAccess({ serverId: server.id }))
      : query.data?.servers.filter((server) => unreadProjection.allowsAccess({ serverId: server.id }))
    if (!raw) return undefined
    // Canonical rail rows intentionally contain renderable aggregates only.
    // Keep using the fresh list response as exact source evidence so the
    // unread projection can reconcile numeric mention badges by channel.
    const liveEvidenceByServer = new Map(
      query.data?.servers.map((server) => [server.id, server]) ?? [],
    )
    let changed = false
    const projected = raw.map((server) => {
      const liveEvidence = liveEvidenceByServer.get(server.id)
      void liveEvidence
      const serverScopes = attentionScopes.filter((scope) => scope.serverId === server.id)
      const unread = serverScopes.some((scope) => scope.ordinaryUnread)
      const mentions = serverScopes.reduce((total, scope) => total + (scope.attentionCount ?? 0), 0)
      if (unread === server.unread && mentions === server.mentions) return server
      changed = true
      return { ...server, unread, mentions }
    })
    return changed ? projected : raw
  }, [attentionScopes, dbRail?.servers, query.data, registry, unreadProjection, unreadVersion])
  return {
    ...query,
    servers: projectedServers ?? (EMPTY_SERVERS as Server[]),
    isLiveAuthoritative: (() => {
      void structuralGeneration
      const authority = liveServerListAuthority.get(queryClient)
      const state = useCommunityWsStore.getState()
      return authority?.viewerId === state.profileViewerId
        && authority.accountEpoch === state.profileAccountEpoch
        && authority.accessEpoch === state.accessEpoch
        && authority.serverIdsSignature === canonicalServerIdsSignature(
          projectedServers ?? EMPTY_SERVERS,
        )
    })(),
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

type RawChannel = Channel & { categoryId: string | null }
async function resolveServerIdentity(
  queryClient: QueryClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<Server | undefined> {
  const cached = queryClient
    .getQueryData<ServersResponse>(communityKeys.servers())
    ?.servers.find((server) => server.id === serverId)
  if (cached) return cached

  const fetched = await serversProjectedQueryFn(
    getActiveAccountUnreadProjection(queryClient),
    queryClient,
    (_token, data) => {
      publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "servers", data },
        proof: { kind: "structural", token: _token, signal },
      })
    },
  )({ signal } as QueryFunctionContext)
  return fetched.servers.find((server) => server.id === serverId)
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
  options: { preserveFailedQuery?: boolean } = {},
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
    publishCommunityLiveSnapshot(queryClient, {
      snapshot: { kind: "server-detail", data },
      proof: { kind: "structural", token: structuralToken, signal },
    })
    return data
  } catch (error) {
    projection.cancelSnapshot(token)
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, signal)
      evictServerChannelScopes(queryClient, serverId, { preserveServerDetailQuery: options.preserveFailedQuery === true
        && queryClient.getQueryState(communityKeys.server(serverId))?.fetchStatus === "fetching" })
    }
    throw error
  }
}

export async function qualifyRestoredCommunityScopes(
  queryClient: QueryClient,
  accountId: string | null,
  snapshot: DehydratedState,
) {
  const rows = (name: string) => snapshot.queries.find((query) => query.queryKey.length === 4
    && query.queryKey[0] === "community" && query.queryKey[1] === "db"
    && query.queryKey[2] === accountId && query.queryKey[3] === name)?.state.data
  const parsedServers = serverSchema.array().safeParse(rows("servers"))
  const parsedChannels = channelSchema.array().safeParse(rows("channels"))
  const servers = parsedServers.success ? parsedServers.data : []
  const channels = parsedChannels.success ? parsedChannels.data : []
  const registry = getCommunityDbRegistry(queryClient)
  const token = captureCommunityLiveSnapshotToken(queryClient)
  if (token.viewerId !== accountId) return
  const projection = getActiveAccountUnreadProjection(queryClient)
  const serverScopes = async () => {
    if (!servers.length) return
    let currentIds: Set<string>
    try {
      const current = await queryClient.fetchQuery({ queryKey: communityKeys.servers(), staleTime: 0, retry: false,
        queryFn: serversProjectedQueryFn(projection, queryClient, (proof, data, signal) => {
          publishCommunityLiveSnapshot(queryClient, { snapshot: { kind: "servers", data }, proof: { kind: "structural", token: proof, signal } })
        }),
      })
      currentIds = new Set(current.servers.map((server) => server.id))
    } catch { return }
    await Promise.all(servers.filter((server) => currentIds.has(server.id)).map(async (server) => {
      try {
        const detail = await queryClient.fetchQuery({ queryKey: communityKeys.server(server.id), staleTime: 0, retry: false,
          queryFn: ({ signal }) => serverProjectedQueryFn(queryClient, server.id, signal, { preserveFailedQuery: true })(),
        })
        const visible = new Set(detail.categories.flatMap((category) => category.channels.map((channel) => channel.id)))
        await Promise.all(channels.filter((channel) => channel.serverId === server.id && channel.type === "thread"
          && channel.parentChannelId && visible.has(channel.parentChannelId)).map(async (channel) => {
          const proof = captureCommunityLiveSnapshotToken(queryClient)
          try {
            await queryClient.fetchQuery({ queryKey: communityKeys.channelMeta(server.id, channel.id), staleTime: 0, retry: false,
              queryFn: async ({ signal }) => {
                const metadata = await fetchChannelMetadata(server.id, channel.id, signal)
                publishCommunityChannelMetadata(queryClient, { metadata, proof: { token: proof, signal } })
                return metadata
              },
            })
          } catch (error) {
            if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
              try { assertCommunityLiveSnapshotTokenCurrent(queryClient, proof, undefined) } catch { return }
              registry?.settleRestoredScope({ kind: "denied-channel", id: channel.id })
              registry?.removePendingRouteScope({ kind: "channel", id: channel.id })
            }
          }
        }))
      } catch {}
    }))
  }
  const scopes = [serverScopes()]
  if (channels.some((channel) => channel.type === "dm")) scopes.push(queryClient.fetchQuery({
    queryKey: communityKeys.dms(), staleTime: 0, retry: false,
    queryFn: dmsProjectedQueryFn(projection, queryClient),
  }).then(() => undefined, () => undefined))
  await Promise.all(scopes)
}

/**
 * Fetches the detail (categories + channels) for one server. Pass `null` for
 * "no active server" (including the DM home) — the query stays disabled and
 * no request fires.
 */
export function useServer(
  serverId: string | null,
): UseQueryResult<ServerDetail> & { server: ServerDetail | null } {
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
      serverProjectedQueryFn(queryClient, serverId, signal, { preserveFailedQuery: true })()
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
  }
}
