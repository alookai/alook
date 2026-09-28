"use client"

import {
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
import { installCommunityDbSync } from "@/lib/community-db/sync"
import {
  getBrowserPersistenceRuntime,
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
    if (refetchOnRegister) {
      void queryClient.refetchQueries({
        queryKey: communityKeys.all,
        type: "active",
        predicate: (query) => query.queryKey[1] !== "db",
      })
    }
    return () => {
      uninstallSync()
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
  children,
  pending,
  userId,
}: {
  children: ReactNode
  pending: ReactNode
  userId: string | null
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
      const runtime = await getBrowserPersistenceRuntime()
      if (cancelled) return
      let registry = createCommunityDbRegistry(queryClient, userId, {
        persistence: runtime.persistence,
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
        registry = createCommunityDbRegistry(queryClient, userId)
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
      queueMicrotask(() => {
        for (const release of ownedLeases) release()
        ownedLeases.clear()
        for (const registry of ownedRegistries) registry.cleanup()
        ownedRegistries.clear()
      })
    }
  }, [queryClient, userId])

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
  return (
    <QueryProviderScope key={userId ?? "anon"} pending={pending} userId={userId}>
      {children}
    </QueryProviderScope>
  )
}
