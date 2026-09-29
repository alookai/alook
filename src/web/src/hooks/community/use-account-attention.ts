"use client"

import { useEffect } from "react"
import { useQuery, type QueryClient } from "@tanstack/react-query"
import type { AccountAttentionSnapshot } from "@alook/shared"
import {
  useAttentionItems,
  useAttentionScopes,
} from "@/lib/community-db/projections"
import {
  ingestAttentionIncluded,
} from "@/lib/community-db/sync"
import {
  getCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { accountAttentionResourceKey } from "@/lib/community-db/account-attention-resource"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"

const missingAttentionOwner = async (): Promise<AccountAttentionSnapshot> => {
  throw new Error("account attention collection is unavailable")
}

export function useAccountAttention() {
  const registry = useOptionalCommunityDbRegistry()
  const scopes = useAttentionScopes()
  const items = useAttentionItems()
  const query = useQuery({
    queryKey: accountAttentionResourceKey(),
    queryFn: registry?.accountAttentionQueryFn ?? missingAttentionOwner,
    enabled: false,
  })
  useEffect(() => {
    if (!registry || !query.data) return
    ingestAttentionIncluded(registry, query.data.included)
  }, [query.data, registry])
  return { ...query, scopes, items }
}

/**
 * Read-only observer for consumers. The shell owns the sole enabled transport;
 * every visible attention surface observes that query plus the canonical rows.
 */
export function useAccountAttentionProjection() {
  const registry = useOptionalCommunityDbRegistry()
  const scopes = useAttentionScopes()
  const items = useAttentionItems()
  const query = useQuery({
    queryKey: accountAttentionResourceKey(),
    queryFn: registry?.accountAttentionQueryFn ?? missingAttentionOwner,
    enabled: false,
  })
  return { ...query, scopes, items }
}

export async function reconcileAccountAttention(
  registry: CommunityDbRegistry,
) {
  await registry.collections.attentionScopes.utils.refetch({ throwOnError: true })
  const snapshot = registry.queryClient.getQueryData<AccountAttentionSnapshot>(
    accountAttentionResourceKey(),
  )
  if (!snapshot) throw new Error("account attention refetch completed without a snapshot")
  ingestAttentionIncluded(registry, snapshot.included)
  return snapshot
}

type AttentionReconcileWaiter = {
  version: number
  resolve: () => void
}

type AttentionReconcileState = {
  version: number
  completedVersion: number
  running: boolean
  deferrals: Set<symbol>
  waiters: AttentionReconcileWaiter[]
}
const attentionReconcileStates = new WeakMap<QueryClient, AttentionReconcileState>()

function attentionReconcileState(queryClient: QueryClient) {
  const current = attentionReconcileStates.get(queryClient)
  if (current) return current
  const created: AttentionReconcileState = {
    version: 0,
    completedVersion: 0,
    running: false,
    deferrals: new Set(),
    waiters: [],
  }
  attentionReconcileStates.set(queryClient, created)
  return created
}

function settleAttentionReconcileWaiters(state: AttentionReconcileState) {
  const pending: AttentionReconcileWaiter[] = []
  for (const waiter of state.waiters) {
    if (waiter.version <= state.completedVersion) waiter.resolve()
    else pending.push(waiter)
  }
  state.waiters = pending
}

function startScheduledAccountAttentionReconcile(
  queryClient: QueryClient,
  state: AttentionReconcileState,
) {
  if (
    state.running
    || state.deferrals.size > 0
    || state.completedVersion >= state.version
  ) return
  state.running = true
  queueMicrotask(() => {
    void (async () => {
      try {
        while (
          state.deferrals.size === 0
          && state.completedVersion < state.version
        ) {
          const targetVersion = state.version
          // An event must never join a request that began before that event.
          // Abort that read first, then let the fresh query capture its own
          // publication token after the local WS projection is complete.
          await queryClient.cancelQueries({
            queryKey: accountAttentionResourceKey(),
            exact: true,
          })
          const registry = getCommunityDbRegistry(queryClient)
          if (registry) await reconcileAccountAttention(registry).catch(() => undefined)
          state.completedVersion = targetVersion
          settleAttentionReconcileWaiters(state)
        }
      } finally {
        state.running = false
        startScheduledAccountAttentionReconcile(queryClient, state)
      }
    })()
  })
}

export function scheduleAccountAttentionReconcile(queryClient: QueryClient) {
  const state = attentionReconcileState(queryClient)
  const version = ++state.version
  const completion = new Promise<void>((resolve) => {
    state.waiters.push({ version, resolve })
  })
  startScheduledAccountAttentionReconcile(queryClient, state)
  return completion
}

export function deferAccountAttentionReconcile(queryClient: QueryClient) {
  const state = attentionReconcileState(queryClient)
  const token = Symbol("account-attention-reconcile")
  state.deferrals.add(token)
  let released = false
  return () => {
    if (released) return
    released = true
    state.deferrals.delete(token)
    startScheduledAccountAttentionReconcile(queryClient, state)
  }
}
