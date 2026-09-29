"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  QueryClientProvider,
  QueryObserver,
  type Query,
  type QueryClient,
  type QueryObserverOptions,
} from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { createQueryClient } from "@/lib/query-client"
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
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import type { ServerRow } from "@/lib/community-db/schema"
import { installCommunityDbSync } from "@/lib/community-db/sync"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import { isDmsResourceQueryKey } from "@/lib/community-db/dms-resource"
import { getConversationNavigationProof } from "@/lib/community/conversation-navigation-proof"
import {
  getBrowserPersistenceRuntime,
  rebuildBrowserPersistenceRuntime,
  registerPersistenceClearScope,
} from "@/lib/browser-persistence"

function leaseCommunityTransportQueries(queryClient: QueryClient) {
  const observers = new Map<Query, () => void>()
  let active = true
  const queryCache = queryClient.getQueryCache?.()
  if (!queryCache) {
    return { dispose: () => {}, stop: () => {} }
  }
  const releaseQuery = (query: Query) => {
    const unsubscribe = observers.get(query)
    if (!unsubscribe) return
    observers.delete(query)
    unsubscribe()
  }
  const unsubscribeCache = queryCache.subscribe((event) => {
    if (
      !active
      || event.type !== "observerAdded"
      || event.query.queryKey[0] !== "community"
      || event.query.queryKey[1] === "db"
      || observers.has(event.query)
    ) return
    const observer = new QueryObserver(
      queryClient,
      event.query.options as QueryObserverOptions,
    )
    let observedFetch = event.query.state.fetchStatus === "fetching"
    observers.set(event.query, () => {})
    const unsubscribe = observer.subscribe((result) => {
      if (result.fetchStatus === "fetching") {
        observedFetch = true
        return
      }
      if (observedFetch) releaseQuery(event.query)
    })
    observers.set(event.query, unsubscribe)
  })
  const stop = () => {
    if (!active) return
    active = false
    unsubscribeCache()
  }
  return {
    stop,
    dispose: () => {
      stop()
      for (const unsubscribe of observers.values()) unsubscribe()
      observers.clear()
    },
  }
}

function CommunityDbRuntime({
  children,
  onStableMount,
  queryClient,
  refetchOnRegister,
  registry,
}: {
  children: ReactNode
  onStableMount: () => void
  queryClient: QueryClient
  refetchOnRegister: boolean
  registry: CommunityDbRegistry
}) {
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountVersion = useRef(0)

  useLayoutEffect(() => {
    if (disposeTimer.current !== null) {
      clearTimeout(disposeTimer.current)
      disposeTimer.current = null
    }
    const unregisterCommunityDb = registerCommunityDbRegistry(registry)
    const unregisterClear = registerPersistenceClearScope(
      `account:${registry.scopeId}:community`,
      registry.clear,
    )
    const uninstallSync = installCommunityDbSync(queryClient, registry)
    const probe = process.env.NODE_ENV !== "production" ? {
      writeServer: async (row: ServerRow) => {
        await registry.ensureCollectionReady("servers")
        registry.collections.servers.utils.writeUpsert(row)
      },
      snapshot: async () => {
        const runtime = await getBrowserPersistenceRuntime()
        const serverRows = Array.from(registry.collections.servers.values())
        const categoryRows = Array.from(registry.collections.categories.values())
        const channelRows = Array.from(registry.collections.channels.values())
        const messageRows = Array.from(registry.collections.messages.values())
        const readStateRows = Array.from(registry.collections.readStates.values())
        const categoryReadiness = registry.getCollectionReadiness("categories")
        const channelReadiness = registry.getCollectionReadiness("channels")
        return {
          collectionId: registry.collections.servers.id,
          collectionStatus: registry.collections.servers.status,
          collectionSize: registry.collections.servers.size,
          collectionRowIds: Array.from(registry.collections.servers.keys()),
          serverDetailRows: serverRows.map((server) => ({
            id: server.id,
            detailComplete: server.detailComplete,
          })),
          readiness: registry.getCollectionReadiness("servers"),
          restored: registry.hasRestoredCollection("servers"),
          persistence: await runtime.inspectCollection(registry.collections.servers.id),
          categoryCollectionStatus: registry.collections.categories.status,
          categoryCollectionSize: categoryRows.length,
          categoryCollectionRowIds: categoryRows.map((category) => category.id),
          categoryReadiness,
          categoryRestored: registry.hasRestoredCollection("categories"),
          categoryPersistence: await runtime.inspectCollection(registry.collections.categories.id),
          channelCollectionStatus: registry.collections.channels.status,
          channelCollectionSize: channelRows.length,
          channelCollectionRowIds: channelRows.map((channel) => channel.id),
          channelReadiness,
          channelRestored: registry.hasRestoredCollection("channels"),
          channelPersistence: await runtime.inspectCollection(registry.collections.channels.id),
          messageCollectionStatus: registry.collections.messages.status,
          messageCollectionSize: messageRows.length,
          messageCollectionRows: messageRows.map((message) => ({
            id: message.id,
            channelId: message.channelId,
          })),
          messageReadiness: registry.getCollectionReadiness("messages"),
          messageRestored: registry.hasRestoredCollection("messages"),
          messagePersistence: await runtime.inspectCollection(registry.collections.messages.id),
          readStateCollectionStatus: registry.collections.readStates.status,
          readStateCollectionSize: readStateRows.length,
          readStateRows: readStateRows.map((row) => ({
            channelId: row.channelId,
            lastReadMessageId: row.lastReadMessageId,
            lastReadSeq: row.lastReadSeq,
          })),
          readStateReadiness: registry.getCollectionReadiness("readStates"),
          readStateRestored: registry.hasRestoredCollection("readStates"),
          navigationProof: getConversationNavigationProof(queryClient),
          serverTreeProjectionGates: serverRows.map((server) => {
            const serverCategories = categoryRows.filter((category) => (
              category.serverId === server.id
            ))
            const serverChannels = channelRows.filter((channel) => (
              channel.serverId === server.id && channel.type !== "thread"
            ))
            return {
              serverId: server.id,
              detailComplete: server.detailComplete,
              categoryRowCount: serverCategories.length,
              channelRowCount: serverChannels.length,
              dependentCollectionsReady: categoryReadiness === "ready"
                && channelReadiness === "ready",
              restoredServerTree: registry.hasRestoredCollection("servers")
                && registry.hasRestoredCollection("channels"),
            }
          }),
        }
      },
    } : null
    if (probe) Reflect.set(window, "__ALOOK_COMMUNITY_DB_PROBE__", probe)
    if (refetchOnRegister) {
      void queryClient.refetchQueries({
        queryKey: communityKeys.all,
        type: "active",
        predicate: (query) => query.queryKey[1] !== "db",
      })
    }
    return () => {
      uninstallSync()
      if (probe && Reflect.get(window, "__ALOOK_COMMUNITY_DB_PROBE__") === probe) {
        Reflect.deleteProperty(window, "__ALOOK_COMMUNITY_DB_PROBE__")
      }
      unregisterClear()
      unregisterCommunityDb()
      disposeTimer.current = setTimeout(() => {
        disposeTimer.current = null
        disposeReadCoordinator(queryClient)
        disposeAccountReadStateReconciliation(queryClient)
        disposeAccountUnreadProjection(queryClient)
      }, 0)
    }
  }, [queryClient, refetchOnRegister, registry])

  useEffect(() => {
    const version = ++mountVersion.current
    queueMicrotask(() => {
      if (mountVersion.current === version) onStableMount()
    })
    return () => {
      mountVersion.current += 1
    }
  }, [onStableMount])

  return <CommunityDbProvider registry={registry}>{children}</CommunityDbProvider>
}

function QueryProviderScope({
  enqueueTeardown,
  children,
  pending,
  userId,
  waitForPriorTeardown,
}: {
  enqueueTeardown: (teardown: () => Promise<void>) => void
  children: ReactNode
  pending: ReactNode
  userId: string | null
  waitForPriorTeardown: () => Promise<void>
}) {
  const [queryClient] = useState(() => createQueryClient())
  const [communityDb, setCommunityDb] = useState<{
    onStableMount: () => void
    refetchOnRegister: boolean
    registry: CommunityDbRegistry
  } | null>(null)
  const unreadProjection = useMemo(
    () => userId ? getAccountUnreadProjection(queryClient, userId) : null,
    [queryClient, userId],
  )

  useEffect(() => {
    let cancelled = false
    const ownedRegistries = new Set<CommunityDbRegistry>()
    const ownedLeases = new Set<() => void>()
    const createMountLease = () => {
      const lease = leaseCommunityTransportQueries(queryClient)
      ownedLeases.add(lease.dispose)
      return lease.stop
    }
    void (async () => {
      await waitForPriorTeardown()
      if (cancelled) return
      const runtime = await getBrowserPersistenceRuntime()
      if (cancelled) return
      let registry = createCommunityDbRegistry(queryClient, userId, {
        persistence: runtime.persistence,
        serverTransport: true,
      })
      ownedRegistries.add(registry)
      const profiles = useCommunityWsStore.getState()
      if (profiles.profileViewerId !== userId) profiles.activateProfileAccount(userId)
      const preload = registry.preload()
      setCommunityDb({
        registry,
        refetchOnRegister: false,
        onStableMount: createMountLease(),
      })
      try {
        await preload
      } catch (error) {
        if (cancelled) return
        console.warn("[Alook persistence] Collection preload failed; using memory only", error)
        const failedRegistry = registry
        registry = createCommunityDbRegistry(queryClient, userId, { serverTransport: true })
        ownedRegistries.add(registry)
        await registry.preload()
        if (cancelled) return
        setCommunityDb({
          registry,
          refetchOnRegister: true,
          onStableMount: createMountLease(),
        })
        setTimeout(() => {
          if (ownedRegistries.delete(failedRegistry)) failedRegistry.cleanup()
        }, 0)
      }
    })()
    return () => {
      cancelled = true
      // React tears passive effects down parent-first. Defer collection
      // disposal until descendant live-query subscriptions have released.
      const leases = [...ownedLeases]
      ownedLeases.clear()
      const registries = [...ownedRegistries]
      ownedRegistries.clear()
      enqueueTeardown(async () => {
        await Promise.resolve()
        for (const release of leases) release()
        const disposableClient = queryClient as QueryClient & {
          cancelQueries?: () => Promise<void>
          clear?: () => void
        }
        await disposableClient.cancelQueries?.()
        await Promise.allSettled(registries.map((registry) => registry.cleanup()))
        disposableClient.clear?.()
      })
    }
  }, [enqueueTeardown, queryClient, userId, waitForPriorTeardown])

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
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => isDmsResourceQueryKey(queryKey),
      })
      void queryClient.invalidateQueries({ queryKey: serversCollectionQueryKey(), exact: true })
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => isCommunityServerDetailQueryKey(queryKey),
      })
    })
    return () => unreadProjection.setReconcileScheduler(null)
  }, [queryClient, unreadProjection])

  const isDev = process.env.NODE_ENV !== "production"
  return (
    <QueryClientProvider client={queryClient}>
      {communityDb ? (
        <CommunityDbRuntime
          onStableMount={communityDb.onStableMount}
          queryClient={queryClient}
          refetchOnRegister={communityDb.refetchOnRegister}
          registry={communityDb.registry}
        >
          {children}
          {isDev ? <ReactQueryDevtools initialIsOpen={false} /> : null}
        </CommunityDbRuntime>
      ) : pending}
    </QueryClientProvider>
  )
}

/** Owns one Query client and one account-scoped collection registry. */
export function QueryProvider({
  children,
  pending,
  userId,
}: {
  children: ReactNode
  pending: ReactNode
  userId: string | null
}) {
  const [restoreGeneration, setRestoreGeneration] = useState(0)
  const [restorePending, setRestorePending] = useState(false)
  const teardownBarrier = useRef<Promise<void>>(Promise.resolve())
  const enqueueTeardown = useCallback((teardown: () => Promise<void>) => {
    const next = teardownBarrier.current.catch(() => {}).then(teardown)
    teardownBarrier.current = next.catch((error) => {
      console.warn("[Alook persistence] Community scope teardown failed", error)
    })
  }, [])
  const waitForPriorTeardown = useCallback(
    () => teardownBarrier.current,
    [],
  )
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      setRestorePending(true)
    }
    window.addEventListener("pageshow", restore)
    return () => window.removeEventListener("pageshow", restore)
  }, [])
  useEffect(() => {
    if (!restorePending) return
    let active = true
    queueMicrotask(() => {
      void waitForPriorTeardown()
        .then(() => rebuildBrowserPersistenceRuntime())
        .catch((error) => console.warn("[Alook persistence] Runtime rebuild failed", error))
        .then(() => {
          if (!active) return
          setRestoreGeneration((generation) => generation + 1)
          setRestorePending(false)
        })
    })
    return () => { active = false }
  }, [restorePending, waitForPriorTeardown])
  if (restorePending) return pending
  return (
    <QueryProviderScope
      key={`${userId ?? "anon"}:${restoreGeneration}`}
      enqueueTeardown={enqueueTeardown}
      pending={pending}
      userId={userId}
      waitForPriorTeardown={waitForPriorTeardown}
    >
      {children}
    </QueryProviderScope>
  )
}
