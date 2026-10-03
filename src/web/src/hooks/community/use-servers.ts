"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { useSelector } from "@tanstack/react-store"



import {
useQuery,
QueryObserver,
useQueryClient,
type QueryClient,
type QueryFunctionContext,
type UseQueryResult,
} from "@tanstack/react-query"
import { useMemo } from "react"
import { createStore } from "@tanstack/store"
import type { ServerRow } from "@/lib/community-db/schema"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { isServerOwner,UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import type { Server,Category,Channel } from "@/lib/community/models/navigation"
import {
getActiveAccountUnreadProjection,
accountUnreadAllowsAccess,
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
type CommunityLiveSnapshotToken,
} from "@/lib/community-db/sync"

const absentAuthority = createStore<null>(null)

function canonicalServerIdsSignature(servers: readonly Pick<Server, "id">[]) {
  return JSON.stringify([...new Set(servers.map((server) => server.id))].sort())
}


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
  if (!context?.client) throw new DOMException("Missing server query owner", "AbortError")
  const token = captureCommunityLiveSnapshotToken(context.client)
  const data = await apiFetch<{ servers: RawServerRow[] }>("/api/community/servers", communityRequestOptions(context.client, token, context.signal))
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
    const registry = structuralToken.registry
    await registry?.ready
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
    await Promise.all([registry!.collections.servers.preload(), registry!.collections.serverMemberships.preload()])
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
    const data = await serversQueryFn(context)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
    projection.absorbSnapshot(token, serverListUnreadSources(data), {
      confirmedAccessScopes: data.servers.map((server) => ({
        kind: "server" as const,
        serverId: server.id,
      })),
    })
    publishCommunityLiveSnapshot(queryClient, {
      snapshot: { kind: "servers", data },
      proof: { kind: "structural", token: structuralToken, signal: context?.signal },
    })
    registry!.serverListAuthority.setState(() => ({
      viewerId: structuralToken.viewerId,
      accountEpoch: structuralToken.accountEpoch,
      accessEpoch: structuralToken.accessEpoch,
      ownerGeneration: structuralToken.ownerGeneration,
      serverIdsSignature: canonicalServerIdsSignature(data.servers),
    }))
    for (const server of data.servers) if (server.unreadSources) projection.absorbLegacyServerAggregate(server.id, server.unreadSources)
    projection.recordLegacySnapshot(data, data.servers.flatMap((server) => server.unread && server.unreadSources === undefined
      ? [{ family: "servers" as const, channelId: `\u0000legacy-server:${server.id}`, serverId: server.id }]
      : []))
    onLiveSuccess?.(structuralToken, data, context?.signal)
    return data.servers.map((server) => server.id)
  } catch (error) {
    projection.cancelSnapshot(token)
    throw error
  }
}

function serversQueryOptions(queryClient: QueryClient) {
  return {
    queryKey: communityKeys.servers(),
    queryFn: serversProjectedQueryFn(getActiveAccountUnreadProjection(queryClient), queryClient),
    staleTime: Infinity,
  } as const
}

export function useServers(): UseQueryResult<string[]> & { servers: Server[]; isLiveAuthoritative: boolean } {
  const registry = useOptionalCommunityDbRegistry()
  const authority = useSelector(registry?.serverListAuthority ?? absentAuthority, (value) => value)
  const attentionScopes = useAttentionScopes()
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  const structuralGeneration = useCommunityWsStore((state) => `${state.profileViewerId ?? ""}:${state.profileAccountEpoch}:${state.accessEpoch}`)
  const unreadProjection = useMemo(() => getActiveAccountUnreadProjection(queryClient), [queryClient])
  const serverAccess = useSelector(unreadProjection.state, (state) => (dbRail?.servers ?? []).map((server) => accountUnreadAllowsAccess(state, { serverId: server.id })), { compare: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]) })
  const query = useQuery({ ...serversQueryOptions(queryClient), refetchOnReconnect: true })
  const servers = useMemo(() => {
    const raw = dbRail?.servers.filter((_server, index) => serverAccess[index])
    if (!raw) return EMPTY_SERVERS as Server[]
    return raw.map((server) => {
      const scopes = attentionScopes.filter((scope) => scope.serverId === server.id)
      const unread = scopes.some((scope) => scope.ordinaryUnread)
      const mentions = scopes.reduce((total, scope) => total + (scope.attentionCount ?? 0), 0)
      return unread === server.unread && mentions === server.mentions ? server : { ...server, unread, mentions }
    })
  }, [attentionScopes, dbRail?.servers, serverAccess])
  void structuralGeneration
  const state = registry?.runtime.ws.get()
  return {
    ...query, servers,
    isLiveAuthoritative: !!authority && Array.isArray(query.data)
      && authority.viewerId === state?.profileViewerId
      && authority.accountEpoch === state?.profileAccountEpoch
      && authority.accessEpoch === state?.accessEpoch
      && authority.ownerGeneration === registry?.runtime.lifecycle.get().generation
      && authority.serverIdsSignature === canonicalServerIdsSignature(servers),
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
async function resolveServerIdentity(queryClient: QueryClient, serverId: string, signal?: AbortSignal): Promise<ServerRow | undefined> {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const registry = token.registry
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  const read = () => queryClient.getQueryData<ServerRow[]>(communityKeys.communityDbCollection(registry!.scopeId, "servers"))?.find((server) => server.id === serverId)
  const cached = read()
  if (cached) return cached
  const options = serversQueryOptions(queryClient)
  const observer = new QueryObserver(queryClient, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  const release = () => unsubscribe()
  signal?.addEventListener("abort", release, { once: true })
  try {
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    await queryClient.fetchQuery(options)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    return read()
  } finally {
    signal?.removeEventListener("abort", release)
    release()
  }
}

const serverQueryFn = (
  queryClient: QueryClient,
  serverId: string,
  signal?: AbortSignal,
) => async (): Promise<ServerDetail> => {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const options = communityRequestOptions(queryClient, token, signal)
  const fetchResource = <T,>(path: string) => apiFetch<T>(path, options)
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
    return await withConversationReadDeadline(signal, async (readSignal) => {
      await structuralToken.registry?.ready
      assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, readSignal)
      await Promise.all([
        structuralToken.registry!.collections.categories.preload(),
        structuralToken.registry!.collections.channels.preload(),
        structuralToken.registry!.collections.channelMemberships.preload(),
      ])
      assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, readSignal)
      const data = await serverQueryFn(queryClient, serverId, readSignal)()
      assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, readSignal)
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
        proof: { kind: "structural", token: structuralToken, signal: readSignal },
      })
      return data.id
    })
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
): UseQueryResult<string> & { server: ServerDetail | null } {
  const attentionScopes = useAttentionScopes()
  const dbServer = useServerTreeProjection(serverId)
  const queryClient = useQueryClient()
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
    staleTime: Infinity,
    refetchOnReconnect: true,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.server(serverId ?? "__none__") }).retry),
    networkMode: "always",
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
  return {
    ...query,
    server: query.error instanceof ApiError
      && (query.error.status === 403 || query.error.status === 404)
      ? null
      : projectedServer,
  }
}
