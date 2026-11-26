"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  AccountAttentionSnapshotSchema,
  COMMUNITY_CONTRACT_HEADER,
  COMMUNITY_INBOX_CONTEXT_HEADER,
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
  headers.set(COMMUNITY_INBOX_CONTEXT_HEADER, "1")
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
  const query = registry.queryClient.getQueryCache().find<{ loaded: boolean; readRevision: number; todosTruncated?: boolean }>({ queryKey: communityKeys.accountAttention(), exact: true })
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
    await publishAccountAttentionSnapshot(queryClient, { snapshot, proof: { token: requestToken, signal } })
    return { loaded: true, readRevision, todosTruncated: Boolean(snapshot.todosTruncated) }
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
    const completed = client.getQueryState<{ loaded: boolean; readRevision: number; todosTruncated?: boolean }>(communityKeys.accountAttention())
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

const DEFAULT_ATTENTION_RECONCILE_DEBOUNCE_MS = 250

type AttentionReconcileSchedulerState = {
  microtaskQueued: boolean
  cooldownTimer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  unsubscribe: (() => void) | null
  inFlightPrefetches: Set<string>
  latestToken: ReturnType<typeof captureCommunityLiveSnapshotToken> | null
}

const attentionReconcileStates = new WeakMap<QueryClient, AttentionReconcileSchedulerState>()

function getAttentionReconcileState(queryClient: QueryClient): AttentionReconcileSchedulerState {
  let state = attentionReconcileStates.get(queryClient)
  if (!state) {
    state = {
      microtaskQueued: false,
      cooldownTimer: null,
      dirty: false,
      unsubscribe: null,
      inFlightPrefetches: new Set(),
      latestToken: null,
    }
    attentionReconcileStates.set(queryClient, state)
  }
  return state
}

function clearAttentionScheduler(state: AttentionReconcileSchedulerState) {
  state.microtaskQueued = false
  state.dirty = false
  if (state.cooldownTimer !== null) {
    clearTimeout(state.cooldownTimer)
    state.cooldownTimer = null
  }
  state.unsubscribe?.()
  state.unsubscribe = null
}

function dispatchAccountAttentionReconcile(queryClient: QueryClient, state: AttentionReconcileSchedulerState) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active || !state.latestToken) {
    clearAttentionScheduler(state)
    return
  }
  try {
    assertCommunityLiveSnapshotTokenCurrent(queryClient, state.latestToken, undefined)
  } catch {
    clearAttentionScheduler(state)
    return
  }

  const query = queryClient.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })
  if (query?.state.fetchStatus === "fetching") {
    state.dirty = true
    if (!state.unsubscribe) {
      state.unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash !== query.queryHash) return
        if (event.query.state.fetchStatus !== "idle") return
        state.unsubscribe?.()
        state.unsubscribe = null
        if (!state.dirty || state.cooldownTimer !== null) return
        state.dirty = false
        dispatchAccountAttentionReconcile(queryClient, state)
      })
    }
    return
  }

  state.dirty = false
  state.cooldownTimer = setTimeout(() => {
    state.cooldownTimer = null
    if (!state.dirty) return
    dispatchAccountAttentionReconcile(queryClient, state)
  }, DEFAULT_ATTENTION_RECONCILE_DEBOUNCE_MS)

  void queryClient.invalidateQueries(
    { queryKey: communityKeys.accountAttention(), exact: true, refetchType: "active" },
    { cancelRefetch: false },
  ).catch(() => undefined)
}

export function scheduleAccountAttentionReconcile(queryClient: QueryClient, message?: { channelId?: string; messageId?: string }) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return
  const state = getAttentionReconcileState(queryClient)
  state.latestToken = captureCommunityLiveSnapshotToken(queryClient)

  if (message?.messageId) {
    const key = `m:${message.messageId}`
    if (!state.inFlightPrefetches.has(key)) {
      state.inFlightPrefetches.add(key)
      void prefetchCommunityMessage(queryClient, message.messageId, { channelId: message.channelId })
        .catch(() => undefined)
        .finally(() => state.inFlightPrefetches.delete(key))
    }
  } else if (message?.channelId) {
    const key = `c:${message.channelId}`
    if (!state.inFlightPrefetches.has(key)) {
      state.inFlightPrefetches.add(key)
      void prefetchCommunityLatestMessage(queryClient, message.channelId)
        .catch(() => undefined)
        .finally(() => state.inFlightPrefetches.delete(key))
    }
  }

  if (state.microtaskQueued) return
  if (state.cooldownTimer !== null) {
    state.dirty = true
    return
  }
  const query = queryClient.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })
  if (query?.state.fetchStatus === "fetching") {
    state.dirty = true
    if (!state.unsubscribe) {
      state.unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash !== query.queryHash) return
        if (event.query.state.fetchStatus !== "idle") return
        state.unsubscribe?.()
        state.unsubscribe = null
        if (!state.dirty || state.cooldownTimer !== null) return
        state.dirty = false
        dispatchAccountAttentionReconcile(queryClient, state)
      })
    }
    return
  }

  state.microtaskQueued = true
  queueMicrotask(() => {
    state.microtaskQueued = false
    dispatchAccountAttentionReconcile(queryClient, state)
  })
}
