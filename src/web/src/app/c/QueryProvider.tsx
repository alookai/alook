"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsRestoring, type QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { createQueryClient } from "@/lib/query-client"
import {
  createIdbPersister,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldPersistQuery,
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
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { installCommunityDbSync } from "@/lib/community-db/sync"

function createRestoreGate() {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  return { ready, release }
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
  const [persister] = useState(() => createIdbPersister(userId))
  const isDev = process.env.NODE_ENV !== "production"

  return (
    <PersistQueryClientProvider
      client={queryClient}
      onSuccess={() => {
        // `onSuccess` runs after hydrate and before `isRestoring` becomes
        // false. Freeze which canonical collections came from that restore so
        // later network results can never be misclassified as persisted.
        communityDb.captureRestoredCollections()
        const profiles = useCommunityWsStore.getState()
        if (profiles.profileViewerId !== userId) {
          profiles.activateProfileAccount(userId)
        }
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
      onError={() => communityDb.captureRestoredCollections()}
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
