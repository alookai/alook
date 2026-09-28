"use client"

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query"
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

function CommunityDbRuntime({
  children,
  queryClient,
  registry,
}: {
  children: ReactNode
  queryClient: QueryClient
  registry: CommunityDbRegistry
}) {
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
  }, [queryClient, registry])

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
  const [communityDb, setCommunityDb] = useState<CommunityDbRegistry | null>(null)
  const unreadProjection = useMemo(
    () => userId ? getAccountUnreadProjection(queryClient, userId) : null,
    [queryClient, userId],
  )

  useEffect(() => {
    let cancelled = false
    const ownedRegistries = new Set<CommunityDbRegistry>()
    void (async () => {
      const runtime = await getBrowserPersistenceRuntime()
      if (cancelled) return
      let registry = createCommunityDbRegistry(queryClient, userId, {
        persistence: runtime.persistence,
      })
      ownedRegistries.add(registry)
      const profiles = useCommunityWsStore.getState()
      if (profiles.profileViewerId !== userId) profiles.activateProfileAccount(userId)
      try {
        await registry.preload()
      } catch (error) {
        if (cancelled) return
        console.warn("[Alook persistence] Collection preload failed; using memory only", error)
        const failedRegistry = registry
        registry = createCommunityDbRegistry(queryClient, userId)
        ownedRegistries.add(registry)
        setTimeout(() => {
          if (ownedRegistries.delete(failedRegistry)) failedRegistry.cleanup()
        }, 0)
        await registry.preload()
        if (cancelled) return
      }
      if (cancelled) return
      registry.captureRestoredCollections()
      // Live queries subscribe reliably once every collection has reached its
      // ready snapshot. The pending frame keeps SSR/hydration geometry stable
      // while OPFS streams; publishing earlier can miss those hydration writes
      // and leave a warm route stuck on localized skeletons.
      setCommunityDb(registry)
    })()
    return () => {
      cancelled = true
      // React tears passive effects down parent-first. Defer collection
      // disposal until descendant live-query subscriptions have released.
      queueMicrotask(() => {
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
        <CommunityDbRuntime queryClient={queryClient} registry={communityDb}>
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
