
import type { QueryClient } from "@tanstack/react-query"


import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityServer } from "@/lib/community-db/sync"
import { retireBotServerDirectories } from "@/lib/community/bot-directory-lifecycle"
import {
  claimOwnerServerDeleteScopeFlush,
  completeOwnerServerDeleteScopeFlush,
  isOwnerServerDeleteScopeFlushReady,
  isOwnerServerDeleteScopeEvictionBlocked,
  ownerServerDeleteScopeFlushCandidates,
} from "@/lib/community/eject-server"


function evictServerChannelScopesNow(queryClient: QueryClient, serverId: string, deleted: boolean) {
  const registry = getCommunityDbRegistry(queryClient)
  if (registry) {
    if (deleted) void retireBotServerDirectories(registry, serverId).catch(error => console.error("Bot directory retirement failed", error))
    purgeCommunityServer(registry, serverId)
  }
}

export function evictServerChannelScopes(queryClient: QueryClient, serverId: string, deleted = false): boolean {
  if (isOwnerServerDeleteScopeEvictionBlocked(queryClient, serverId)) return false
  evictServerChannelScopesNow(queryClient, serverId, deleted)
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
    evictServerChannelScopesNow(queryClient, serverId, true)
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
