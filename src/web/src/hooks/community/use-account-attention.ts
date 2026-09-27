"use client"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  AccountAttentionSnapshotSchema,
  type AccountAttentionSnapshot,
} from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import {
  useAttentionItems,
  useAttentionScopes,
  useCanonicalChannelsById,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishAccountAttentionSnapshot,
} from "@/lib/community-db/sync"
import {
  getCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import { useDms } from "@/hooks/community/use-dms"

class StaleAttentionReadError extends Error {
  constructor() {
    super("stale D1 attention read")
    this.name = "StaleAttentionReadError"
  }
}

async function fetchAccountAttention(signal?: AbortSignal): Promise<AccountAttentionSnapshot> {
  const response = await apiFetch<AccountAttentionSnapshot & { stale?: boolean }>(
    "/api/community/users/me/attention",
    signal ? { signal } : undefined,
  )
  if (response.stale) throw new StaleAttentionReadError()
  return AccountAttentionSnapshotSchema.parse(response)
}

const accountAttentionQueryFn = (queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const token = captureCommunityLiveSnapshotToken(queryClient)
    const snapshot = await fetchAccountAttention(signal)
    publishAccountAttentionSnapshot(queryClient, {
      snapshot,
      proof: { token, signal },
    })
    return snapshot
  }

export function useAccountAttention() {
  const queryClient = useQueryClient()
  const scopes = useAttentionScopes()
  const items = useAttentionItems()
  const query = useQuery({
    queryKey: communityKeys.accountAttention(),
    queryFn: accountAttentionQueryFn(queryClient),
    staleTime: 0,
    refetchOnMount: "always",
  })
  return { ...query, scopes, items }
}

/**
 * Attention owns only stable structural refs. When those refs arrive before a
 * cold route has loaded their canonical owners, enable the existing structural
 * directory/DM queries. Their normal publishers hydrate the shared collections
 * and every Inbox observer then recomposes without a second attention request.
 */
export function useAccountAttentionScopeHydration() {
  const scopes = useAttentionScopes()
  const channelsById = useCanonicalChannelsById()
  const needsServerChannels = scopes.some((scope) => (
    Boolean(scope.serverId) && !channelsById.has(scope.channelId)
  ))
  const needsDms = scopes.some((scope) => (
    !scope.serverId && !channelsById.has(scope.channelId)
  ))
  useChannelRefDirectory(needsServerChannels)
  useDms(needsDms)
}

/**
 * Read-only observer for consumers. The shell owns the sole enabled transport;
 * every visible attention surface observes that query plus the canonical rows.
 */
export function useAccountAttentionProjection() {
  const queryClient = useQueryClient()
  const scopes = useAttentionScopes()
  const items = useAttentionItems()
  const query = useQuery({
    queryKey: communityKeys.accountAttention(),
    queryFn: accountAttentionQueryFn(queryClient),
    enabled: false,
  })
  return { ...query, scopes, items }
}

export async function reconcileAccountAttention(
  registry: CommunityDbRegistry,
) {
  const snapshot = await registry.queryClient.fetchQuery({
    queryKey: communityKeys.accountAttention(),
    queryFn: accountAttentionQueryFn(registry.queryClient),
    staleTime: 0,
  })
  return snapshot
}

type AttentionReconcileState = { version: number; running: boolean }
const attentionReconcileStates = new WeakMap<QueryClient, AttentionReconcileState>()

export function scheduleAccountAttentionReconcile(queryClient: QueryClient) {
  const state = attentionReconcileStates.get(queryClient) ?? { version: 0, running: false }
  state.version += 1
  attentionReconcileStates.set(queryClient, state)
  if (state.running) return
  state.running = true
  queueMicrotask(() => {
    void (async () => {
      try {
        while (true) {
          const targetVersion = state.version
          // An event must never join a request that began before that event.
          // Abort that read first, then let the fresh query capture its own
          // publication token after the local WS projection is complete.
          await queryClient.cancelQueries({
            queryKey: communityKeys.accountAttention(),
            exact: true,
          })
          const registry = getCommunityDbRegistry(queryClient)
          if (registry) await reconcileAccountAttention(registry).catch(() => undefined)
          if (state.version === targetVersion) break
        }
      } finally {
        state.running = false
        if (state.version > 0 && !getCommunityDbRegistry(queryClient)) {
          attentionReconcileStates.delete(queryClient)
        }
      }
    })()
  })
}
