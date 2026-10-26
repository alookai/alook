"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  AccountAttentionSnapshotSchema,
  COMMUNITY_CONTRACT_HEADER,
  COMMUNITY_RESOURCE_CONTRACT_VERSION,
  type AccountAttentionSnapshot,
} from "@alook/shared"
import { isAbortError } from "@/lib/errors"
import { conversationReadRetryPolicy } from "@/lib/community/conversation-read"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import {
  useAttentionItems,
  useAttentionScopes,
} from "@/lib/community-db/projections"
import {
  beginCommunityCommandRevision,
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

function currentReadRevision(registry: CommunityDbRegistry | null) {
  let revision = registry?.collections.readStateClock.get("account")?.revision ?? -1
  for (const row of registry?.collections.readStates.values() ?? []) revision = Math.max(revision, row.observedRevision ?? -1)
  return revision
}

export function accountAttentionMatchesReadState(registry: CommunityDbRegistry) {
  const query = registry.queryClient.getQueryCache().find<{ loaded: boolean; readRevision: number }>({ queryKey: communityKeys.accountAttention(), exact: true })
  return query?.state.status === "success" && query.state.fetchStatus === "idle"
    && query.state.data?.readRevision === currentReadRevision(registry)
}

const accountAttentionQueryFn = (queryClient: QueryClient) => {
  const token = getCommunityDbRegistry(queryClient) ? captureCommunityLiveSnapshotToken(queryClient) : null
  return async ({ signal, meta }: { signal?: AbortSignal; meta?: Record<string, unknown> } = {}) => {
    if (!token) throw new DOMException("Attention owner retired", "AbortError")
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    const requestToken = beginCommunityCommandRevision(queryClient, token)
    const readRevision = currentReadRevision(token.registry)
    const query = queryClient.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })
    if (meta) meta.attentionReadRevision = readRevision
    const snapshot = await fetchAccountAttention(communityRequestOptions(queryClient, requestToken, signal))
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    if (!query || queryClient.getQueryCache().get(query.queryHash) !== query) throw new DOMException("Attention query retired", "AbortError")
    if (currentReadRevision(token.registry) !== readRevision) throw new StaleAttentionReadError()
    publishAccountAttentionSnapshot(queryClient, { snapshot, proof: { token: requestToken, signal } })
    return { loaded: true, readRevision }
  }
}

function accountAttentionOptions(queryClient: QueryClient) {
  const meta = queryClient.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })?.meta ?? {}
  return {
    queryKey: communityKeys.accountAttention(),
    queryFn: accountAttentionQueryFn(queryClient),
    meta,
    retry: attentionReadRetryPolicy(queryClient),
    staleTime: 0,
  }
}

export function useAccountAttention() {
  const queryClient = useQueryClient()
  const scopes = useAttentionScopes()
  const items = useAttentionItems()
  const query = useQuery({
    ...accountAttentionOptions(queryClient),
    refetchOnMount: "always",
    refetchInterval: query => query.state.status === "error" && !isAbortError(query.state.error) ? 5_000 : false,
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
    ...accountAttentionOptions(queryClient),
    enabled: false,
  })
  return { ...query, scopes, items }
}

export async function reconcileAccountAttention(
  registry: CommunityDbRegistry,
) {
  const client = registry.queryClient, token = captureCommunityLiveSnapshotToken(client)
  const query = client.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })
  if (query?.state.fetchStatus === "fetching" && query.meta?.attentionReadRevision !== currentReadRevision(registry)) {
    await client.cancelQueries({ queryKey: communityKeys.accountAttention(), exact: true })
    assertCommunityLiveSnapshotTokenCurrent(client, token, undefined)
    const completed = client.getQueryState<{ loaded: boolean; readRevision: number }>(communityKeys.accountAttention())
    if (completed && !completed.isInvalidated && accountAttentionMatchesReadState(registry)) return completed.data!
  }
  const snapshot = await registry.queryClient.query({
    ...accountAttentionOptions(registry.queryClient),
    retry: (failures, error) => error instanceof StaleAttentionReadError && failures < 3,
    select: undefined,
  })
  return snapshot
}

function attentionReadRetryPolicy(queryClient: QueryClient) {
  const retry = conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.accountAttention() }).retry)
  return (failures: number, error: Error) => error instanceof StaleAttentionReadError ? failures < 3 : retry(failures, error)
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
