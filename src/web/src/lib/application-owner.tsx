"use client"

import { UnauthorizedError } from "@/lib/errors"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { QueryClientProvider } from "@tanstack/react-query"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS } from "@/lib/query-persister"
import { usePersistedAccountLifecycle } from "@/lib/use-persisted-account-lifecycle"
import { shouldPersistApplicationQuery } from "@/lib/workspace-chat-persistence"
import { createStore, createStoreContext, useSelector } from "@tanstack/react-store"
import { useRouter } from "next/navigation"
import { useSession, currentSessionViewer } from "@/lib/auth-client"
import { DEFAULT_INBOX_TYPES, readStoredInboxFilterTypes } from "@/lib/inbox-filter"
import { createQueryClient } from "@/lib/query-client"
import { getNotificationEnabled, getNotificationEvents, NOTIFICATION_EVENTS, type NotificationEvent } from "@/lib/browser-notification"
import type { ApiRequestOptions } from "@/lib/api/client"

export function createApplicationOwner(userId: string, queryClient = createQueryClient()) {
  const bindings = createStore({ retireDisk: () => clearPersistedCache(userId), sessionViewer: () => userId as string | null | undefined })
  return { userId, queryClient, retireDisk: () => bindings.get().retireDisk(), sessionViewer: () => bindings.get().sessionViewer(), bindAuthentication: (sessionViewer: () => string | null | undefined, retireDisk: () => Promise<void>) => bindings.setState(() => ({ sessionViewer, retireDisk })), lifecycle: createStore({ active: true, generation: 0 }), preferences: createStore({ inboxFilterTypes: [...DEFAULT_INBOX_TYPES], hydrated: false, lastWorkspaceSlug: null as string | null, localValues: new Map<string, unknown>(), browserNotifications: { enabled: false, events: [...NOTIFICATION_EVENTS] as NotificationEvent[] } }) }
}
export type ApplicationOwner = ReturnType<typeof createApplicationOwner>
const { StoreProvider, useStoreContext } = createStoreContext<{ owner: ApplicationOwner }>()
export const useApplicationOwner = () => useStoreContext().owner

export function ApplicationOwnerProvider({ owner, children }: { owner: ApplicationOwner; children?: ReactNode }) {
  return <StoreProvider value={{ owner }}>{children}</StoreProvider>
}

export function captureApplicationOwner(owner: ApplicationOwner) {
  return { owner, generation: owner.lifecycle.get().generation }
}
export function assertApplicationOwner(
  token: ReturnType<typeof captureApplicationOwner>, signal?: AbortSignal,
) {
  const state = token.owner.lifecycle.get()
  if (!state.active || state.generation !== token.generation || signal?.aborted) {
    throw new DOMException("Retired application owner", "AbortError")
  }
}
export async function runApplicationRequest<T>(
  owner: ApplicationOwner, load: (options: ApiRequestOptions) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  const token = captureApplicationOwner(owner)
  assertApplicationOwner(token, signal)
  try {
    const result = await load({ authenticationAccount: owner.userId, signal, assertActive: () => assertApplicationOwner(token, signal), onUnauthorized: () => invalidateApplicationAuthentication(token, signal) })
    assertApplicationOwner(token, signal)
    return result
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error
    assertApplicationOwner(token, signal)
    throw error
  }
}

export function ApplicationQueryProvider(props: { userId: string; children: ReactNode }) {
  const session = useSession()
  return <ScopedApplicationQueryProvider key={props.userId} {...props} session={session} sessionViewer={currentSessionViewer} />
}

export function PublicQueryProvider({ children }: { children: ReactNode }) {
  const session = useSession()
  const userId = session.isPending ? "__pending__" : session.data?.user.id ?? "__guest__"
  return <ScopedPublicQueryProvider key={userId} userId={userId}>{children}</ScopedPublicQueryProvider>
}

function ScopedPublicQueryProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [owner] = useState(() => createApplicationOwner(userId))
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    if (disposeTimer.current !== null) { clearTimeout(disposeTimer.current); disposeTimer.current = null }
    owner.lifecycle.setState((state) => ({ ...state, active: true }))
    return () => {
      retireApplicationOwner(owner)
      disposeTimer.current = setTimeout(() => owner.queryClient.clear(), 0)
    }
  }, [owner])
  return <StoreProvider value={{ owner }}><QueryClientProvider client={owner.queryClient}>{children}</QueryClientProvider></StoreProvider>
}
function ScopedApplicationQueryProvider({ userId, children, session, sessionViewer }: { userId: string; children: ReactNode; session: ReturnType<typeof useSession>; sessionViewer: () => string | null | undefined }) {
  const [owner] = useState(() => createApplicationOwner(userId))
  const [handles] = useState(() => ({ owner }))
  const [persister] = useState(() => createIdbPersister(userId, "application"))
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const hydrate = () => {
      const inboxFilterTypes = readStoredInboxFilterTypes(userId)
      let lastWorkspaceSlug: string | null = null
      try { lastWorkspaceSlug = localStorage.getItem(`alook:${userId}:lastWorkspace`) } catch {}
      owner.preferences.setState((state) => ({ ...state, inboxFilterTypes, lastWorkspaceSlug, hydrated: true, browserNotifications: { enabled: getNotificationEnabled(userId), events: getNotificationEvents(userId) } }))
    }
    hydrate()
    const onStorage = (event: StorageEvent) => {
      if (event.key === `alook:${userId}:inbox-filter-types` || event.key === `alook:${userId}:lastWorkspace` || event.key === `alook:${userId}:browser-notification-enabled` || event.key === `alook:${userId}:browser-notification-events` || event.key === null) hydrate()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [owner, userId])
  const active = useSelector(owner.lifecycle, (state) => state.active)
  useLayoutEffect(() => { owner.bindAuthentication(sessionViewer, persister.retireAccount) }, [owner, sessionViewer, persister])
  const onRetired = useCallback(() => { if (!owner.lifecycle.get().active) return; retireApplicationOwner(owner); owner.queryClient.clear(); window.location.reload() }, [owner])
  usePersistedAccountLifecycle(persister, onRetired)
  const router = useRouter()
  const identityChanged = !session.isPending && !session.error && session.data?.user.id !== userId
  useLayoutEffect(() => {
    if (disposeTimer.current !== null) { clearTimeout(disposeTimer.current); disposeTimer.current = null }
    owner.lifecycle.setState((state) => state.active ? state : { ...state, active: true })
    return () => {
      owner.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
      void owner.queryClient.cancelQueries()
      const viewer = owner.sessionViewer()
      if (viewer !== undefined && viewer !== owner.userId) void owner.retireDisk().catch(() => undefined)
      disposeTimer.current = setTimeout(() => { disposeTimer.current = null; owner.queryClient.clear() }, 0)
    }
  }, [owner])
  useLayoutEffect(() => {
    if (!identityChanged || !owner.lifecycle.get().active) return
    retireApplicationOwner(owner)
    void owner.queryClient.cancelQueries()
    owner.queryClient.clear()
    void owner.retireDisk().catch(() => undefined)
    if (!session.data?.user.id) router.replace("/sign-in")
    else router.refresh()
  }, [identityChanged, owner, router, session.data?.user.id])
  return <StoreProvider value={handles}>
    <PersistQueryClientProvider client={owner.queryClient} onSuccess={() => { if (!owner.lifecycle.get().active) owner.queryClient.clear() }} persistOptions={{ persister, buster: `${PERSIST_BUSTER}-application`, maxAge: PERSIST_MAX_AGE_MS, dehydrateOptions: { shouldDehydrateQuery: (query) => query.state.status === "success" && shouldPersistApplicationQuery(query.queryKey), shouldDehydrateMutation: () => false } }}>
      {active && !identityChanged ? children : null}
    </PersistQueryClientProvider>
  </StoreProvider>
}

export function retireApplicationOwner(owner: ApplicationOwner) {
  owner.preferences.setState((state) => ({ ...state, localValues: new Map() }))
  owner.lifecycle.setState((state) => state.active ? { active: false, generation: state.generation + 1 } : state)
  void owner.queryClient.cancelQueries()
}

export function applicationKey(owner: ApplicationOwner, ...parts: readonly unknown[]) {
  return ["application", owner.userId, ...parts] as const
}

export async function invalidateApplicationAuthentication(token: ReturnType<typeof captureApplicationOwner>, signal?: AbortSignal) {
  assertApplicationOwner(token, signal)
  const owner = token.owner
  retireApplicationOwner(owner)
  const generation = owner.lifecycle.get().generation
  owner.queryClient.clear()
  await owner.retireDisk().catch(() => undefined)
  const state = owner.lifecycle.get()
  const viewer = owner.sessionViewer()
  return !state.active && state.generation === generation && (viewer === undefined || viewer === null || viewer === owner.userId)
}
