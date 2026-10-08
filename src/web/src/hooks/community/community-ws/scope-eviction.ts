
import type { QueryClient } from "@tanstack/react-query"


import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityServer } from "@/lib/community-db/sync"
import {
  claimOwnerServerDeleteScopeFlush,
  completeOwnerServerDeleteScopeFlush,
  isOwnerServerDeleteScopeFlushReady,
  isOwnerServerDeleteScopeEvictionBlocked,
  ownerServerDeleteScopeFlushCandidates,
} from "@/lib/community/eject-server"


function evictServerChannelScopesNow(queryClient: QueryClient, serverId: string) {
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
