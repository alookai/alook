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
import { useEffect, useMemo } from "react"
import { createStore } from "@tanstack/store"
import type { ServerRow } from "@/lib/community-db/schema"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { isServerOwner,UNCATEGORIZED_CATEGORY_ID, type CommunityRole } from "@alook/shared"
import type { Server,Category,Channel } from "@/lib/community/models/navigation"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { ApiError, isAbortError } from "@/lib/errors"
import { evictServerChannelScopes } from "./community-ws/scope-eviction"
import {
useOptionalCommunityDbRegistry,
useServerRailProjection,
useServerTreeProjection,
useServerMemberRows,
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
  memberId?: string
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
    unread: false,
    mentions: 0,
    isOwner: isServerOwner(s.role),
    ...(["owner", "admin", "member"].includes(s.role ?? "") ? { role: s.role as CommunityRole } : {}),
    ...(s.memberId ? { memberId: s.memberId } : {}),
    icon: s.icon ?? null,
    official: s.official === true,
  }))
  return { servers }
}

export const serversProjectedQueryFn = (
  queryClient: QueryClient,
  onLiveSuccess?: (
    token: CommunityLiveSnapshotToken,
    data: ServersResponse,
    signal: AbortSignal | undefined,
  ) => void,
) => async (context?: QueryFunctionContext) => {
  const structuralToken = captureCommunityLiveSnapshotToken(queryClient)
  try {
    const registry = structuralToken.registry
    await registry?.ready
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
    await Promise.all([registry!.collections.servers.preload(), registry!.collections.serverMemberships.preload()])
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
    const data = await serversQueryFn(context)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, structuralToken, context?.signal)
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
    onLiveSuccess?.(structuralToken, data, context?.signal)
    return data.servers.map((server) => server.id)
  } catch (error) {
    throw error
  }
}

function serversQueryOptions(queryClient: QueryClient) {
  return {
    queryKey: communityKeys.servers(),
    queryFn: serversProjectedQueryFn(queryClient),
    staleTime: 30_000,
  } as const
}

export function useServers(): UseQueryResult<string[]> & { servers: Server[]; isLiveAuthoritative: boolean } {
  const registry = useOptionalCommunityDbRegistry()
  const authority = useSelector(registry?.serverListAuthority ?? absentAuthority, (value) => value)
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  const structuralGeneration = useCommunityWsStore((state) => `${state.profileViewerId ?? ""}:${state.profileAccountEpoch}:${state.accessEpoch}`)
  const serverAccess = useCommunityWsStore((state) => state.revokedServerIds)
  const query = useQuery({ ...serversQueryOptions(queryClient), refetchOnReconnect: true })
  const servers = useMemo(() => {
    const raw = dbRail?.servers.filter((_server) => !serverAccess.has(_server.id))
    if (!raw) return EMPTY_SERVERS as Server[]
    return raw
  }, [dbRail?.servers, serverAccess])
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

export function useViewerServerRole(serverId: string | null, viewerId: string): CommunityRole | undefined {
  const registry = useOptionalCommunityDbRegistry()
  const runtime = useCommunityRuntime()
  const { servers } = useServers()
  const authority = useSelector(registry?.serverListAuthority ?? absentAuthority, (value) => value)
  const ownerGeneration = useSelector(runtime.lifecycle, (state) => state.active ? state.generation : -1)
  const memberships = useServerMemberRows(serverId, [viewerId])
  const qualified = useCommunityWsStore((state) => !!authority
    && authority.viewerId === viewerId && state.profileViewerId === viewerId
    && authority.accountEpoch === state.profileAccountEpoch
    && authority.ownerGeneration === ownerGeneration
    && !!serverId && !state.revokedServerIds.has(serverId))
  if (!qualified || viewerId !== registry?.accountId
    || !servers.some((server) => server.id === serverId)) return undefined
  const membership = memberships.find((row) => row.viewer && row.userId === viewerId)
  const role = membership?.role
  return role === "owner" || role === "admin" || role === "member" ? role : undefined
}

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
    await queryClient.query({ ...options, select: undefined })
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

function serverDetailReadSuperseded(queryClient: QueryClient, serverId: string, token: CommunityLiveSnapshotToken, signal?: AbortSignal) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry || registry !== token.registry) return false
  const state = registry.runtime.ws.get()
  const lifecycle = registry.runtime.lifecycle.get()
  return !signal?.aborted && lifecycle.active && lifecycle.generation === token.ownerGeneration
    && state.profileViewerId === token.viewerId && state.profileAccountEpoch === token.accountEpoch
    && state.accessEpoch !== token.accessEpoch && !state.revokedServerIds.has(serverId)
}

class SupersededServerDetailRead extends DOMException {
  constructor(readonly token: CommunityLiveSnapshotToken, readonly signal: AbortSignal | undefined) {
    super("Superseded server detail read", "AbortError")
  }
}

export const serverProjectedQueryFn = (
  queryClient: QueryClient,
  serverId: string,
  signal?: AbortSignal,
) => async () => {
  const structuralToken = captureCommunityLiveSnapshotToken(queryClient)
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
      publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "server-detail", data },
        proof: { kind: "structural", token: structuralToken, signal: readSignal },
      })
      return data.id
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      evictServerChannelScopes(queryClient, serverId)
    }
    if (isAbortError(error) && serverDetailReadSuperseded(queryClient, serverId, structuralToken, signal)) {
      throw new SupersededServerDetailRead(structuralToken, signal)
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
    staleTime: 30_000,
    refetchOnReconnect: true,
    retryOnMount: false,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.server(serverId ?? "__none__") }).retry),
    networkMode: "always",
  })
  const restart = query.refetch
  useEffect(() => {
    const error = query.error
    if (serverId && error instanceof SupersededServerDetailRead && serverDetailReadSuperseded(queryClient, serverId, error.token, error.signal)) {
      void restart({ cancelRefetch: false })
    }
  }, [query.error, queryClient, serverId, restart])
  return {
    ...query,
    server: query.error instanceof ApiError
      && (query.error.status === 403 || query.error.status === 404)
      ? null
      : dbServer ?? null,
  }
}
