"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useIsRestoring, type QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { createQueryClient } from "@/lib/query-client"
import { isAbortError } from "@/lib/errors"
import {
  createIdbPersister,
  createCommunityRestorePersister,
  type CommunityRestoredCollections,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldDehydrateCommunityQuery,
} from "@/lib/query-persister"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"
import { disposeReadCoordinator } from "@/hooks/community/read-coordinator"
import {
  communityKeys,
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
import { discardCommunityRestoreReplacements, installCommunityDbSync, restoreCommunityCollections } from "@/lib/community-db/sync"
import { profileSchema } from "@/lib/community-db/schema"
import { avatarInitial } from "@/lib/community/avatar"
import type { CurrentUser } from "@/contexts/community/current-user"
import { observeHydration, discardHydration } from "@/lib/observability/restore"
import { captureTelemetryIdentityRetirement, setTelemetryUser } from "@/lib/observability/client"

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

  useEffect(() => {
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
        void registry.cleanup().finally(() => queryClient.clear()).catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Community collection cleanup failed", error)
        })
      }, 0)
    }
  }, [queryClient, registry])

  useLayoutEffect(() => {
    if (isRestoring) return
    onRestoreComplete()
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
        id: userId, name: initialUser.name, discriminator: initialUser.discriminator || null,
        ...(initialUser.avatar === avatarInitial(initialUser.name) ? {} : { avatar: initialUser.avatar }),
        avatarVersion: initialUser.avatarVersion,
        identityComplete: !!initialUser.discriminator && initialUser.avatar !== avatarInitial(initialUser.name) && initialUser.avatarVersion !== undefined,
        aboutMe: initialUser.aboutMe, statusEmoji: initialUser.statusEmoji, statusText: initialUser.statusText,
      })], { updatedAt: 0 })
    }
    return client
  })
  const [restoreGate] = useState(createRestoreGate)
  const [communityDb] = useState(() => createCommunityDbRegistry(queryClient, userId, { waitForRestore: restoreGate.ready }))
  // Persister is bound to the userId at construction; on account switch the
  // whole community subtree unmounts and the shell re-renders with the new
  // id, so we don't need to reactively rebuild the persister mid-session.
  const [persister] = useState(() => createIdbPersister(userId))
  const [restore] = useState(() => createCommunityRestorePersister(persister, userId))
  const active = useSelector(communityDb.runtime.lifecycle, (state) => state.active)
  const router = useRouter()
  useLayoutEffect(() => { communityDb.bindAuthentication(sessionViewer, persister.retireAccount, persister.retireChannels) }, [communityDb, sessionViewer, persister])
  const retireTelemetryIdentity = useRef<() => void>(() => undefined)
  useLayoutEffect(() => { setTelemetryUser(userId); retireTelemetryIdentity.current = captureTelemetryIdentityRetirement() }, [userId])
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
    if (!identityChanged) return
    if (!session.data?.user.id && sessionViewer?.() === null) retireTelemetryIdentity.current()
    if (identityRetired.current) return
    identityRetired.current = true
    restoreGate.release()
    retireCommunityAccount(communityDb)
    void communityDb.retireDisk().catch(() => undefined)
    if (!session.data?.user.id) router.replace("/sign-in")
  }, [communityDb, identityChanged, restoreGate, router, session.data?.user.id, sessionViewer, userId])
  const onRetired = useCallback(() => {
    if (!communityDb.runtime.lifecycle.get().active) return
    retireCommunityAccount(communityDb)
    window.location.reload()
  }, [communityDb])
  usePersistedAccountLifecycle(persister, onRetired)
  const isDev = process.env.NODE_ENV !== "production"
  const settleRestoredAccount = async (input: CommunityRestoredCollections) => {
    try {
      if (!communityDb.runtime.lifecycle.get().active) { queryClient.clear(); return }
      await restoreCommunityCollections(communityDb, input)
      communityDb.captureRestoredCollections(input)
      const profiles = communityDb.runtime.ws.get()
      if (profiles.profileViewerId !== userId) communityDb.runtime.ws.actions.activateProfileAccount(userId)
    } finally {
      discardCommunityRestoreReplacements(communityDb)
      restoreGate.release()
    }
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      onSuccess={async () => {
        const input = restore.takeCollections()
        await settleRestoredAccount(await persister.isCurrent() ? input : {})
        if (communityDb.runtime.lifecycle.get().active) observeHydration(persister)
        else discardHydration(persister)

      }}
      onError={async () => { restore.takeCollections(); discardHydration(persister); await settleRestoredAccount({}) }}
      persistOptions={{
        persister: restore.persister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster: PERSIST_BUSTER,
        dehydrateOptions: {
          shouldDehydrateQuery: shouldDehydrateCommunityQuery,
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
