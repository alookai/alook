"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  AccountAttentionSnapshotSchema,
  type AccountAttentionSnapshot,
} from "@alook/shared"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import {
  useAttentionItems,
  useAttentionScopes,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotTokenCurrent,
  publishAccountAttentionSnapshot,
} from "@/lib/community-db/sync"
import {
  getCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"

class StaleAttentionReadError extends Error {
  constructor() {
    super("stale D1 attention read")
    this.name = "StaleAttentionReadError"
  }
}

async function fetchAccountAttention(options: ApiRequestOptions): Promise<AccountAttentionSnapshot> {
  const response = await apiFetch<AccountAttentionSnapshot & { stale?: boolean }>(
    "/api/community/users/me/attention",
    options,
  )
  if (response.stale) throw new StaleAttentionReadError()
  return AccountAttentionSnapshotSchema.parse(response)
}

const accountAttentionQueryFn = (queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const token = captureCommunityLiveSnapshotToken(queryClient)
    const snapshot = await fetchAccountAttention(communityRequestOptions(queryClient, token, signal))
    publishAccountAttentionSnapshot(queryClient, {
      snapshot,
      proof: { token, signal },
    })
    return { loaded: true }
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

export function scheduleAccountAttentionReconcile(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return
  const token = captureCommunityLiveSnapshotToken(queryClient)
  void queryClient.cancelQueries({ queryKey: communityKeys.accountAttention(), exact: true }).then(() => {
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    return queryClient.invalidateQueries({ queryKey: communityKeys.accountAttention(), exact: true, refetchType: "active" }, { cancelRefetch: false })
  }).catch(() => undefined)
}
