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
  userId,
}: {
  children: ReactNode
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
    let registry: CommunityDbRegistry | null = null
    let published = false
    void (async () => {
      const runtime = await getBrowserPersistenceRuntime()
      registry = createCommunityDbRegistry(queryClient, userId, {
        persistence: runtime.persistence,
      })
      try {
        await registry.preload()
      } catch (error) {
        registry.cleanup()
        console.warn("[Alook persistence] Collection preload failed; using memory only", error)
        registry = createCommunityDbRegistry(queryClient, userId)
        await registry.preload()
      }
      if (cancelled) {
        registry.cleanup()
        return
      }
      registry.captureRestoredCollections()
      const profiles = useCommunityWsStore.getState()
      if (profiles.profileViewerId !== userId) profiles.activateProfileAccount(userId)
      setCommunityDb(registry)
      published = true
    })()
    return () => {
      cancelled = true
      if (!published) return
      // React tears passive effects down parent-first. Defer collection
      // disposal until descendant live-query subscriptions have released.
      queueMicrotask(() => {
        registry?.cleanup()
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
      ) : null}
    </QueryClientProvider>
  )
}

/**
 * Owns one Query client and one account-scoped collection registry. The
 * product subtree mounts only after the persisted collections have preloaded,
 * so an older account can never flash while an account switch is restoring.
 */
export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null
}) {
  return (
    <QueryProviderScope key={userId ?? "anon"} userId={userId}>
      {children}
    </QueryProviderScope>
  )
}
