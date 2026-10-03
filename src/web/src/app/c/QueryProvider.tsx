"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsRestoring, type QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { createQueryClient } from "@/lib/query-client"
import { isAbortError } from "@/lib/errors"
import {
  createIdbPersister,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldPersistQuery,
} from "@/lib/query-persister"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"
import { disposeReadCoordinator } from "@/hooks/community/read-coordinator"
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
import { useSelector } from "@tanstack/react-store"
import { useSession, currentSessionViewer } from "@/lib/auth-client"
import { useRouter } from "next/navigation"
import { usePersistedAccountLifecycle } from "@/lib/use-persisted-account-lifecycle"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { installCommunityDbSync } from "@/lib/community-db/sync"
import { profileSchema } from "@/lib/community-db/schema"
import type { CurrentUser } from "@/contexts/community/current-user"

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
      disposeTimer.current = setTimeout(() => {
        disposeTimer.current = null
        unregisterCommunityDb()
        void queryClient.cancelQueries().catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Community query cancellation failed", error)
        })
        disposeReadCoordinator(queryClient)
        disposeAccountReadStateReconciliation(queryClient)
        disposeAccountUnreadProjection(queryClient)
        void registry.cleanup().finally(() => queryClient.clear()).catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Community collection cleanup failed", error)
        })
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
 * module-scoped singleton across users. Collections remain alive with this
 * account owner and are cleaned up after its descendants release.
 *
 * `userId` scopes the IndexedDB namespace so account switches never surface
 * the previous session's cached message list. Passing `null` (pre-auth) hits
 * an "anon" namespace that never carries real content.
 */
export function QueryProvider(props: { children: ReactNode; userId: string | null; initialUser?: CurrentUser }) {
  const session = useSession()
  return <ScopedQueryProvider key={props.userId ?? "anon"} {...props} session={session} sessionViewer={currentSessionViewer} />
}

function ScopedQueryProvider({
  children,
  userId,
  initialUser,
  session,
  sessionViewer,
}: {
  children: ReactNode
  userId: string | null
  initialUser?: CurrentUser
  session: ReturnType<typeof useSession>
  sessionViewer: () => string | null | undefined
}) {
  const [queryClient] = useState(() => {
    const client = createQueryClient()
    if (initialUser && initialUser.id === userId) {
      client.setQueryData(communityKeys.communityDbCollection(userId, "profiles"), [profileSchema.parse({
        userId, name: initialUser.name, discriminator: initialUser.discriminator ?? "",
        avatar: initialUser.avatar, avatarVersion: initialUser.avatarVersion ?? 0,
        aboutMe: initialUser.aboutMe, statusEmoji: initialUser.statusEmoji, statusText: initialUser.statusText,
      })], { updatedAt: 0 })
    }
    return client
  })
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
  const active = useSelector(communityDb.runtime.lifecycle, (state) => state.active)
  const router = useRouter()
  useLayoutEffect(() => { communityDb.bindAuthentication(sessionViewer, persister.retireAccount) }, [communityDb, sessionViewer, persister])
  const identityRetired = useRef(false)
  const identityChanged = !session.isPending && !session.error && session.data?.user.id !== userId
  useLayoutEffect(() => {
    communityDb.authenticationView.setState((state) => ({ ...state, active: true }))
    return () => {
      communityDb.authenticationView.setState((state) => ({ active: false, generation: state.generation + 1 }))
      const viewer = communityDb.sessionViewer()
      if (viewer !== undefined && viewer !== communityDb.accountId) {
        retireCommunityAccount(communityDb)
        restoreGate.release()
        void communityDb.retireDisk().catch(() => undefined)
      }
    }
  }, [communityDb, restoreGate])
  useLayoutEffect(() => {
    if (!identityChanged || identityRetired.current) return
    identityRetired.current = true
    restoreGate.release()
    retireCommunityAccount(communityDb)
    void communityDb.retireDisk().catch(() => undefined)
    if (session.data?.user.id) router.refresh()
    else router.replace("/sign-in")
  }, [communityDb, identityChanged, restoreGate, router, session.data?.user.id, userId])
  const onRetired = useCallback(() => {
    if (!communityDb.runtime.lifecycle.get().active) return
    retireCommunityAccount(communityDb)
    window.location.reload()
  }, [communityDb])
  usePersistedAccountLifecycle(persister, onRetired)
  const isDev = process.env.NODE_ENV !== "production"
  const settleRestoredAccount = () => {
    restoreGate.release()
    if (!communityDb.runtime.lifecycle.get().active) { queryClient.clear(); return }
    communityDb.captureRestoredCollections()
    const profiles = communityDb.runtime.ws.get()
    if (profiles.profileViewerId !== userId) {
      communityDb.runtime.ws.actions.activateProfileAccount(userId)
    }
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      onSuccess={() => {
        // `onSuccess` runs after hydrate and before `isRestoring` becomes
        // false. Freeze which canonical collections came from that restore so
        // later network results can never be misclassified as persisted.
        settleRestoredAccount()
        if (!communityDb.runtime.lifecycle.get().active) return
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
      onError={settleRestoredAccount}
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
      {active && !identityChanged ? <CommunityDbRuntime
        onRestoreComplete={restoreGate.release}
        queryClient={queryClient}
        registry={communityDb}
      >
        {children}
        {isDev ? <ReactQueryDevtools initialIsOpen={false} /> : null}
      </CommunityDbRuntime> : null}
    </PersistQueryClientProvider>
  )
}
