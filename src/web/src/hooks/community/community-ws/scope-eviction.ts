import type { Query, QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCommunityStore } from "@/stores/community"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { clearTypingIndicator } from "./typing"
import { updateStructuralSnapshot } from "@/lib/community/structural-snapshot"
import {
  claimOwnerServerDeleteScopeFlush,
  completeOwnerServerDeleteScopeFlush,
  isOwnerServerDeleteScopeFlushReady,
  isOwnerServerDeleteScopeEvictionBlocked,
  ownerServerDeleteScopeFlushCandidates,
} from "@/lib/community/eject-server"

type ThreadPageLike = {
  serverId?: string
  threads?: Array<{ id?: string }>
}

export function collectChannelScopeIds(
  queryClient: QueryClient,
  serverId: string,
  channelId?: string,
) {
  const ids = new Set<string>(channelId ? [channelId] : [])
  const store = useCommunityStore.getState()
  const current = store.currentChannelMeta
  if (store.currentServerId === serverId && store.currentChannelId
    && (!channelId || current?.parentChannelId === channelId)) ids.add(store.currentChannelId)
  for (const [id, scope] of useCommunityWsStore.getState().channelAccessScopes) {
    if (scope.serverId === serverId && (!channelId || scope.parentChannelId === channelId)) ids.add(id)
  }
  for (const [, meta] of queryClient.getQueriesData<{ id: string; parentChannelId?: string }>(
    { queryKey: communityKeys.channelMetaRoot(serverId) },
  )) {
    if (meta && (!channelId || meta.parentChannelId === channelId)) ids.add(meta.id)
  }
  for (const { scope } of useMessageStreamStore.getState().entries.values()) {
    if (!channelId && scope.kind === "channel" && scope.serverId === serverId) ids.add(scope.id)
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== "object") return
    const row = value as Record<string, unknown>
    if (!channelId || row.parentChannelId === channelId) {
      if (typeof row.childChannelId === "string") ids.add(row.childChannelId)
      if (typeof row.id === "string" && (row.type === "thread" || row.type === "text" || row.type === "forum")) ids.add(row.id)
    }
    for (const child of Object.values(row)) if (child && typeof child === "object") visit(child)
  }
  for (const [, data] of queryClient.getQueriesData({ queryKey: communityKeys.server(serverId) })) visit(data)
  for (const [key, data] of queryClient.getQueriesData<
    ThreadPageLike | { pages: ThreadPageLike[] }
  >({
    queryKey: ["community", "channel"],
    predicate: (query) => query.queryKey[3] === "threads" && (!channelId || query.queryKey[2] === channelId),
  })) {
    if (!data) continue
    const pages = "pages" in data ? data.pages : [data]
    for (const page of pages) {
      if (page.serverId !== serverId) continue
      ids.add(key[2] as string)
      for (const thread of page.threads ?? []) if (thread.id) ids.add(thread.id)
    }
  }
  return ids
}

function scopeQuery(query: Query, serverId: string, channelId: string) {
  const key = query.queryKey
  if (key[0] !== "community") return false
  if (key[1] === "channel" && key[2] === channelId) return true
  if (key[1] === "message-context" && key[2] === "channel" && key[3] === channelId) return true
  if (key[1] === "servers" && key[2] === serverId
    && (key[3] === "channel-meta" || key[3] === "forum-sidebar-retained") && key[4] === channelId) return true
  if (key[1] !== "message" && key[1] !== "reaction-details") return false
  const data = query.state.data as { channelId?: string; scope?: { channelId?: string } } | undefined
  const ownerChannelId = data?.channelId ?? data?.scope?.channelId
  return !ownerChannelId || ownerChannelId === channelId
}

export function evictScopeContent(
  queryClient: QueryClient,
  serverId: string,
  channelId: string,
) {
  const predicate = (query: Query) => scopeQuery(query, serverId, channelId)
  void queryClient.cancelQueries({ predicate })
  queryClient.removeQueries({ predicate })
  useMessageStreamStore.getState().removeScope({ kind: "channel", id: channelId, serverId })
  const store = useCommunityStore.getState()
  for (const userId of store.typingByScope.get(`ch:${channelId}`)?.keys() ?? []) {
    clearTypingIndicator(`ch:${channelId}`, userId)
  }
  if (store.currentChannelId === channelId) {
    store.setCurrentChannelMeta(null)
    store.setCurrentChannelId(null)
  }
  if (store.subscription.channelId === channelId || store.subscription.secondaryChannelId === channelId) {
    const subscription = { ...store.subscription }
    if (subscription.channelId === channelId) delete subscription.channelId
    if (subscription.secondaryChannelId === channelId) delete subscription.secondaryChannelId
    useCommunityStore.setState({
      subscription,
      ...(store.subscription.secondaryChannelId === channelId ? { secondaryChannelOwner: null } : {}),
    })
  }
}

function evictServerChannelScopesNow(queryClient: QueryClient, serverId: string) {
  useCommunityWsStore.getState().revokeServerAccess(serverId)
  for (const id of collectChannelScopeIds(queryClient, serverId)) {
    evictScopeContent(queryClient, serverId, id)
  }
  void queryClient.cancelQueries({ queryKey: communityKeys.server(serverId) })
  queryClient.removeQueries({ queryKey: communityKeys.server(serverId) })
  queryClient.setQueryData<{ servers: Array<{ id: string }> } | undefined>(
    communityKeys.servers(),
    (current) => current
      ? { ...current, servers: current.servers.filter((server) => server.id !== serverId) }
      : current,
  )
  useMessageStreamStore.getState().removeServer(serverId)
  const community = useCommunityStore.getState()
  if (community.currentServerId === serverId) {
    community.setCurrentChannelMeta(null)
    community.setCurrentChannelId(null)
    community.setCurrentServerId(null)
  }
  updateStructuralSnapshot(queryClient, { type: "removeServer", serverId })
}

export function evictServerChannelScopes(queryClient: QueryClient, serverId: string): boolean {
  if (isOwnerServerDeleteScopeEvictionBlocked(serverId)) return false
  evictServerChannelScopesNow(queryClient, serverId)
  return true
}

function flushOwnerServerDeleteScopes(
  queryClient: QueryClient,
  serverIds: readonly string[],
): string[] {
  const flushed: string[] = []
  for (const serverId of serverIds) {
    if (!isOwnerServerDeleteScopeFlushReady(serverId)) continue
    if (!claimOwnerServerDeleteScopeFlush(serverId)) continue
    evictServerChannelScopesNow(queryClient, serverId)
    if (!completeOwnerServerDeleteScopeFlush(serverId)) continue
    flushed.push(serverId)
  }
  return flushed
}

export function flushOwnerServerDeleteAfterSuccess(
  queryClient: QueryClient,
  serverId: string,
): boolean {
  return flushOwnerServerDeleteScopes(queryClient, [serverId]).length === 1
}

export function flushOwnerServerDeleteRouteCommit(
  queryClient: QueryClient,
): string[] {
  return flushOwnerServerDeleteScopes(
    queryClient,
    ownerServerDeleteScopeFlushCandidates(),
  )
}
