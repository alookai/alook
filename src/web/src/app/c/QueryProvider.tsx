"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsRestoring, type QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { PersistQueryClientProvider, type PersistedClient } from "@tanstack/react-query-persist-client"
import { createQueryClient } from "@/lib/query-client"
import {
  createIdbPersister,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldPersistQuery,
  filterPersistedScopeAuthority,
  mergeQuarantinedPersistedClient,
} from "@/lib/query-persister"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"
import { disposeReadCoordinator } from "@/hooks/community/read-coordinator"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  disposeAccountUnreadProjection,
  getAccountUnreadProjection,
} from "@/hooks/community/account-unread-projection"
import {
  communityKeys,
  isCommunityServerDetailQueryKey,
} from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  getActiveCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
  type RestoredScopeDecision,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { installCommunityDbSync, reconcileCommunityRestore } from "@/lib/community-db/sync"
import { channelSchema, serverSchema } from "@/lib/community-db/schema"
import { qualifyRestoredCommunityScopes } from "@/hooks/community/use-servers"

function createRestoreGate() {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  let accountEpoch: number | null = null
  return { ready, release,
    recordIdentity: (epoch: number) => { accountEpoch = epoch },
    hasIdentity: () => accountEpoch !== null,
    matchesIdentity: (epoch: number) => accountEpoch === epoch,
  }
}

function CommunityDbRuntime({
  children,
  onRestoreComplete,
  queryClient,
  registry,
}: {
  children: ReactNode
  onRestoreComplete: () => void
  queryClient: QueryClient
  registry: CommunityDbRegistry
}) {
  const isRestoring = useIsRestoring()
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    if (disposeTimer.current !== null) {
      clearTimeout(disposeTimer.current)
      disposeTimer.current = null
    }
    const unregisterCommunityDb = registerCommunityDbRegistry(registry)
    return () => {
      unregisterCommunityDb()
      disposeTimer.current = setTimeout(() => {
        disposeTimer.current = null
        disposeReadCoordinator(queryClient)
        disposeAccountReadStateReconciliation(queryClient)
        disposeAccountUnreadProjection(queryClient)
      }, 0)
    }
  }, [queryClient, registry])

  useLayoutEffect(() => {
    if (isRestoring) return
    onRestoreComplete()
    // A collection preload writes the queryFn result into TanStack Query. It
    // must not run before persisted hydration, otherwise a fresh empty array
    // outranks the older canonical rows on disk by dataUpdatedAt.
    return installCommunityDbSync(queryClient, registry)
  }, [isRestoring, onRestoreComplete, queryClient, registry])

  return <CommunityDbProvider registry={registry}>{children}</CommunityDbProvider>
}

/**
 * Owns the TanStack QueryClient for the community subtree.
 *
 * The client is held in `useState(() => createQueryClient())` so React
 * strict-mode double-invoke in dev doesn't discard queries between mounts and
 * so each SSR request gets its own instance rather than sharing a
 * module-scoped singleton across users. Coexists with `<CommunityProvider>`
 * during the God-context migration — later steps move state into TanStack
 * Query and Zustand, then delete the old provider.
 *
 * `userId` scopes the IndexedDB namespace so account switches never surface
 * the previous session's cached message list. Passing `null` (pre-auth) hits
 * an "anon" namespace that never carries real content.
 */
export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null
}) {
  const [queryClient] = useState(() => createQueryClient())
  const [restoreGate] = useState(createRestoreGate)
  const [communityDb] = useState(() => createCommunityDbRegistry(queryClient, userId, {
    waitForRestore: restoreGate.ready,
  }))
  const unreadProjection = useMemo(
    () => userId ? getAccountUnreadProjection(queryClient, userId) : null,
    [queryClient, userId],
  )
  useEffect(() => {
    if (!unreadProjection) return
    unreadProjection.setReconcileScheduler(() => {
      void queryClient.invalidateQueries({
        queryKey: communityKeys.inboxUnreads(),
        exact: true,
      })
      void queryClient.invalidateQueries({
        queryKey: communityKeys.inboxMentions(),
        exact: true,
      })
      void queryClient.invalidateQueries({ queryKey: communityKeys.dms(), exact: true })
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => isCommunityServerDetailQueryKey(queryKey),
      })
    })
    return () => unreadProjection.setReconcileScheduler(null)
  }, [queryClient, unreadProjection])
  // Persister is bound to the userId at construction; on account switch the
  // whole community subtree unmounts and the shell re-renders with the new
  // id, so we don't need to reactively rebuild the persister mid-session.
  const [persister] = useState(() => {
    const storage = createIdbPersister(userId)
    let quarantined: PersistedClient | undefined
    const beforeRead: RestoredScopeDecision[] = []
    const unknownChannels = new Set<string>()
    const unknownServers = new Set<string>()
    const allowedServers = new Set<string>()
    const rows = (name: string) => quarantined?.clientState.queries.find((query) => query.queryKey[3] === name)?.state.data
    const currentChannels = () => {
      const parsed = channelSchema.array().safeParse(rows("channels"))
      return parsed.success ? parsed.data : []
    }
    const retained = () => {
      if (!quarantined) return undefined
      const snapshot = filterPersistedScopeAuthority(quarantined, userId,
        new Set([...unknownServers, ...currentChannels().filter((channel) => unknownChannels.has(channel.id))
          .flatMap((channel) => channel.serverId ? [channel.serverId] : [])]), unknownChannels)
      return { ...snapshot, clientState: { ...snapshot.clientState, queries: snapshot.clientState.queries.map((query) =>
        ["categories", "serverMemberships", "folderItems"].includes(query.queryKey[3] as string)
          ? { ...query, state: { ...query.state, data: (query.state.data as Array<{ serverId: string }>)
            .filter((row) => unknownServers.has(row.serverId)) } } : query) } }
    }
    const deny = (ids: Iterable<string>) => {
      const denied = new Set(ids)
      let changed = true
      while (changed) {
        changed = false
        for (const channel of currentChannels()) if (channel.parentChannelId && denied.has(channel.parentChannelId)
          && !denied.has(channel.id)) { denied.add(channel.id); changed = true }
      }
      for (const id of denied) unknownChannels.delete(id)
      communityDb.removePendingRouteTypes(denied)
    }
    const release = (ids: Iterable<string>) => {
      if (!quarantined) return
      const channels = new Set([...ids].filter((id) => unknownChannels.has(id)))
      const requiredServers = new Set([...allowedServers, ...currentChannels().filter((row) => channels.has(row.id))
        .flatMap((row) => row.serverId ? [row.serverId] : [])])
      const qualified = filterPersistedScopeAuthority(quarantined, userId, requiredServers, channels)
      reconcileCommunityRestore(queryClient, userId, { ...qualified.clientState,
        queries: qualified.clientState.queries.map((query) => ["servers", "categories", "serverMemberships"].includes(query.queryKey[3] as string)
          ? { ...query, state: { ...query.state, data: [] } } : query) })
      for (const id of channels) unknownChannels.delete(id)
      communityDb.removePendingRouteTypes(channels)
    }
    const settleScope = (decision: RestoredScopeDecision) => {
      const state = useCommunityWsStore.getState()
      if (getActiveCommunityDbRegistry() !== communityDb || state.profileViewerId !== userId
        || restoreGate.hasIdentity() && !restoreGate.matchesIdentity(state.profileAccountEpoch)) return
      if (!quarantined) { beforeRead.push(decision); return }
      const cached = currentChannels()
      if (decision.kind === "server-list") {
        const present = new Set(decision.ids)
        for (const id of unknownServers) if (!present.has(id)) {
          unknownServers.delete(id)
          allowedServers.delete(id)
          deny(cached.filter((channel) => channel.serverId === id).map((channel) => channel.id))
        }
      } else if (decision.kind === "server") {
        allowedServers.add(decision.id)
        unknownServers.delete(decision.id)
        const visible = new Set(decision.channelIds)
        deny(cached.filter((channel) => channel.serverId === decision.id && channel.type !== "thread"
          && !visible.has(channel.id)).map((channel) => channel.id))
        release(decision.channelIds)
      } else if (decision.kind === "dms") {
        const visible = new Set(decision.channelIds)
        deny(cached.filter((channel) => channel.type === "dm" && !visible.has(channel.id)).map((channel) => channel.id))
        release(decision.channelIds)
      } else if (decision.kind === "channel") {
        release([decision.id])
      } else if (decision.kind === "denied-server") {
        unknownServers.delete(decision.id)
        allowedServers.delete(decision.id)
        deny(cached.filter((channel) => channel.serverId === decision.id).map((channel) => channel.id))
      } else deny([decision.id])
      quarantined = retained()
    }
    communityDb.setRestoredScopeListener(settleScope)
    return {
      ...storage,
      persistClient: (client: PersistedClient) => {
        const state = useCommunityWsStore.getState()
        if (getActiveCommunityDbRegistry() !== communityDb || state.profileViewerId !== userId
          || !restoreGate.matchesIdentity(state.profileAccountEpoch)) return Promise.resolve()
        return storage.persistClient(mergeQuarantinedPersistedClient(client, retained(), userId))
      },

      restoreClient: async () => {
        if (getActiveCommunityDbRegistry() !== communityDb) throw new DOMException("Inactive restore owner", "AbortError")
        const account = useCommunityWsStore.getState()
        if (account.profileViewerId !== userId) account.activateProfileAccount(userId)
        const epoch = useCommunityWsStore.getState().profileAccountEpoch
        restoreGate.recordIdentity(epoch)
        const restored = await storage.restoreClient()
        if (getActiveCommunityDbRegistry() !== communityDb || useCommunityWsStore.getState().profileViewerId !== userId
          || useCommunityWsStore.getState().profileAccountEpoch !== epoch) throw new DOMException("Stale restore owner", "AbortError")
        if (restored && (!restored.timestamp || !Number.isFinite(restored.timestamp))) {
          await storage.removeClient()
          return undefined
        }
        if (!restored || restored.buster !== PERSIST_BUSTER
          || Date.now() - restored.timestamp > PERSIST_MAX_AGE_MS) return restored
        communityDb.stageRestoredRouteTypes(restored.clientState)
        quarantined = restored
        const parsedServers = serverSchema.array().safeParse(rows("servers"))
        for (const server of parsedServers.success ? parsedServers.data : []) unknownServers.add(server.id)
        for (const channel of currentChannels()) unknownChannels.add(channel.id)
        for (const decision of beforeRead.splice(0)) settleScope(decision)
        void qualifyRestoredCommunityScopes(queryClient, userId, restored.clientState)
        const qualified = filterPersistedScopeAuthority(restored, userId, new Set(), new Set())
        return { ...qualified, clientState: reconcileCommunityRestore(queryClient, userId, qualified.clientState) }
      },
    }
  })
  const isDev = process.env.NODE_ENV !== "production"
  const settleRestoredAccount = () => {
    const state = useCommunityWsStore.getState()
    if (getActiveCommunityDbRegistry() !== communityDb || state.profileViewerId !== userId
      || !restoreGate.matchesIdentity(state.profileAccountEpoch)) return false
    communityDb.captureRestoredCollections()
    return true
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      onSuccess={() => {
        // `onSuccess` runs after hydrate and before `isRestoring` becomes
        // false. Freeze which canonical collections came from that restore so
        // later network results can never be misclassified as persisted.
        if (!settleRestoredAccount()) return
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: communityKeys.servers(),
            exact: true,
            refetchType: "active",
          }),
          queryClient.invalidateQueries({
            queryKey: communityKeys.folders(),
            exact: true,
            refetchType: "active",
          }),
          queryClient.invalidateQueries({
            queryKey: communityKeys.dms(),
            exact: true,
            refetchType: "active",
          }),
          queryClient.invalidateQueries({
            predicate: ({ queryKey }) => isCommunityServerDetailQueryKey(queryKey),
            refetchType: "active",
          }),
        ])
      }}
      // A failed IndexedDB read still completes the identity handoff. The
      // account gate remains visible until this atomically clears any previous
      // viewer state, then the new account mounts against an empty live cache.
      onError={() => { if (!settleRestoredAccount()) void queryClient.cancelQueries() }}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster: PERSIST_BUSTER,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => {
            // Two-stage filter:
            // 1. Key must be in the persisted allowlist (canonical collection
            //    rows plus the retained raw read closure).
            // 2. For raw message queries, `pages[0]` must be a trusted
            //    newest-tail shape. A since-mode or older-only envelope has
            //    no `hasMore` flag on page 0 → the next mount reads
            //    `hasMoreOlder ?? hasMore ?? false` as false and silently
            //    loses history. Filter these out at write time so the
            //    self-healing invariant holds across sessions.
            if (query.state.status !== "success") return false
            return shouldPersistQuery(query.queryKey, query.state.data)
          },
        },
      }}
    >
      <CommunityDbRuntime
        onRestoreComplete={restoreGate.release}
        queryClient={queryClient}
        registry={communityDb}
      >
        {children}
        {isDev ? <ReactQueryDevtools initialIsOpen={false} /> : null}
      </CommunityDbRuntime>
    </PersistQueryClientProvider>
  )
}
