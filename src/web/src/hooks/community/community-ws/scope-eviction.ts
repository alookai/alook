
import { getCommunityRuntime, readCurrentCommunityChannelMeta } from "@/stores/community/runtime"
import type { Query, QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"


import { clearTypingIndicator } from "./typing"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityServer } from "@/lib/community-db/sync"
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
  const store = getCommunityRuntime(queryClient).ui.get()
  const current = readCurrentCommunityChannelMeta(queryClient)
  if (store.currentServerId === serverId && store.currentChannelId
    && (!channelId || current?.parentChannelId === channelId)) ids.add(store.currentChannelId)
  for (const [id, scope] of getCommunityRuntime(queryClient).ws.get().channelAccessScopes) {
    if (scope.serverId === serverId && (!channelId || scope.parentChannelId === channelId)) ids.add(id)
  }
  for (const [, meta] of queryClient.getQueriesData<{ id: string; parentChannelId?: string }>(
    { queryKey: communityKeys.channelMetaRoot(serverId) },
  )) {
    if (meta && (!channelId || meta.parentChannelId === channelId)) ids.add(meta.id)
  }
  for (const { scope } of getCommunityRuntime(queryClient).messageStream.get().entries.values()) {
    if (!channelId && scope.kind === "channel" && scope.serverId === serverId) ids.add(scope.id)
  }
  const registry = getCommunityDbRegistry(queryClient)
  for (const row of registry?.collections.channels.values() ?? []) {
    if (row.serverId === serverId && (!channelId || row.id === channelId || row.parentChannelId === channelId)) ids.add(row.id)
  }
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
  options?: { queries?: ReadonlySet<Query>; assertView?: () => void },
) {
  const predicate = (query: Query) => scopeQuery(query, serverId, channelId) && (!options?.queries || options.queries.has(query))
  void queryClient.cancelQueries({ predicate })
  queryClient.removeQueries({ predicate })
  getCommunityRuntime(queryClient).messageStream.actions.removeScope({ kind: "channel", id: channelId, serverId })
  const store = getCommunityRuntime(queryClient).ui.get()
  for (const userId of store.typingByScope.get(`ch:${channelId}`)?.keys() ?? []) {
    clearTypingIndicator(queryClient, `ch:${channelId}`, userId)
  }
  try { options?.assertView?.() } catch { return }
  if (store.currentChannelId === channelId) {
    getCommunityRuntime(queryClient).ui.actions.setCurrentChannelId(null)
  }
  if (store.subscription.channelId === channelId || store.subscription.secondaryChannelId === channelId) {
    const subscription = { ...store.subscription }
    if (subscription.channelId === channelId) delete subscription.channelId
    if (subscription.secondaryChannelId === channelId) delete subscription.secondaryChannelId
    getCommunityRuntime(queryClient).ui.setState((state) => ({ ...state,
      subscription,
      ...(store.subscription.secondaryChannelId === channelId ? { secondaryChannelOwner: null } : {}),
    }))
  }
}

function evictServerChannelScopesNow(queryClient: QueryClient, serverId: string) {
  getCommunityRuntime(queryClient).ws.actions.revokeServerAccess(serverId)
  for (const id of collectChannelScopeIds(queryClient, serverId)) {
    evictScopeContent(queryClient, serverId, id)
  }
  queryClient.setQueryData<string[] | undefined>(
    communityKeys.servers(),
    (current) => current
      ? current.filter((id) => id !== serverId)
      : current,
  )
  getCommunityRuntime(queryClient).messageStream.actions.removeServer(serverId)
  const community = getCommunityRuntime(queryClient).ui.get()
  if (community.currentServerId === serverId) {
    getCommunityRuntime(queryClient).ui.actions.setCurrentChannelId(null)
    getCommunityRuntime(queryClient).ui.actions.setCurrentServerId(null)
  }
  const registry = getCommunityDbRegistry(queryClient)
  if (registry) purgeCommunityServer(registry, serverId)
}

export function evictServerChannelScopes(queryClient: QueryClient, serverId: string): boolean {
  if (isOwnerServerDeleteScopeEvictionBlocked(queryClient, serverId)) return false
  evictServerChannelScopesNow(queryClient, serverId)
  return true
}

function flushOwnerServerDeleteScopes(
  queryClient: QueryClient,
  serverIds: readonly string[],
): string[] {
  const flushed: string[] = []
  for (const serverId of serverIds) {
    if (!isOwnerServerDeleteScopeFlushReady(queryClient, serverId)) continue
    if (!claimOwnerServerDeleteScopeFlush(queryClient, serverId)) continue
    evictServerChannelScopesNow(queryClient, serverId)
    if (!completeOwnerServerDeleteScopeFlush(queryClient, serverId)) continue
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
    ownerServerDeleteScopeFlushCandidates(queryClient),
  )
}
