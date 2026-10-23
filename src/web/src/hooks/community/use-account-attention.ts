"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  AccountAttentionSnapshotSchema,
  COMMUNITY_CONTRACT_HEADER,
  COMMUNITY_RESOURCE_CONTRACT_VERSION,
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
import { prefetchCommunityMessage, prefetchCommunityLatestMessage } from "./use-message"

class StaleAttentionReadError extends Error {
  constructor() {
    super("stale D1 attention read")
    this.name = "StaleAttentionReadError"
  }
}

async function fetchAccountAttention(options: ApiRequestOptions): Promise<AccountAttentionSnapshot> {
  const headers = new Headers(options.headers)
  headers.set(COMMUNITY_CONTRACT_HEADER, String(COMMUNITY_RESOURCE_CONTRACT_VERSION))
  const response = await apiFetch<AccountAttentionSnapshot & { stale?: boolean }>(
    "/api/community/users/me/attention",
    { ...options, headers },
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
  const snapshot = await registry.queryClient.query({
    queryKey: communityKeys.accountAttention(),
    queryFn: accountAttentionQueryFn(registry.queryClient),
    staleTime: 0,
    select: undefined,
  })
  return snapshot
}

export function scheduleAccountAttentionReconcile(queryClient: QueryClient, message?: { channelId?: string; messageId?: string }) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return
  const token = captureCommunityLiveSnapshotToken(queryClient)
  if (message?.messageId) {
    void prefetchCommunityMessage(queryClient, message.messageId, { channelId: message.channelId }).catch(() => undefined)
  } else if (message?.channelId) {
    void prefetchCommunityLatestMessage(queryClient, message.channelId).catch(() => undefined)
  }
  void queryClient.cancelQueries({ queryKey: communityKeys.accountAttention(), exact: true }).then(() => {
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    return queryClient.invalidateQueries({ queryKey: communityKeys.accountAttention(), exact: true, refetchType: "active" }, { cancelRefetch: false })
  }).catch(() => undefined)
}
