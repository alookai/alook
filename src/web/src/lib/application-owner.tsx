"use client"

import { UnauthorizedError } from "@/lib/errors"
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { clearPersistedCache, createIdbPersister } from "@/lib/query-persister"
import { usePersistedAccountLifecycle } from "@/lib/use-persisted-account-lifecycle"
import { createStore, createStoreContext } from "@tanstack/react-store"
import { useSession, currentSessionViewer } from "@/lib/auth-client"
import { createQueryClient } from "@/lib/query-client"
import type { ApiRequestOptions } from "@/lib/api/client"
import { captureTelemetryIdentityRetirement, setTelemetryUser } from "@/lib/observability/client"
import { disposeQueryDiagnostics } from "@/lib/observability/query-observer"

export function createApplicationOwner(userId: string, queryClient = createQueryClient()) {
  const bindings = createStore({ retireDisk: () => clearPersistedCache(userId), sessionViewer: () => userId as string | null | undefined })
  return { userId, queryClient, retireDisk: () => bindings.get().retireDisk(), sessionViewer: () => bindings.get().sessionViewer(), bindAuthentication: (sessionViewer: () => string | null | undefined, retireDisk: () => Promise<void>) => bindings.setState(() => ({ sessionViewer, retireDisk })), lifecycle: createStore({ active: true, generation: 0 }) }
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

export function PublicQueryProvider({ children }: { children: ReactNode }) {
  const session = useSession()
  const viewer = !session.isPending && !session.error ? session.data?.user.id ?? "__guest__" : undefined
  const [confirmed, setConfirmed] = useState(viewer ?? "__pending__")
  if (viewer !== undefined && viewer !== confirmed) setConfirmed(viewer)
  const userId = viewer ?? confirmed
  return <ScopedPublicQueryProvider key={userId} userId={userId}>{children}</ScopedPublicQueryProvider>
}

function ScopedPublicQueryProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [owner] = useState(() => createApplicationOwner(userId))
  const [persister] = useState(() => createIdbPersister(userId === "__pending__" || userId === "__guest__" ? null : userId))
  useLayoutEffect(() => { owner.bindAuthentication(currentSessionViewer, persister.retireAccount) }, [owner, persister])
  const onRetired = useCallback(() => {
    if (!owner.lifecycle.get().active) return
    retireApplicationOwner(owner)
    owner.queryClient.clear()
    window.location.reload()
  }, [owner])
  usePersistedAccountLifecycle(persister, onRetired)
  const retireTelemetryIdentity = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    if (userId === "__pending__" || userId === "__guest__") return
    setTelemetryUser(userId)
    retireTelemetryIdentity.current = captureTelemetryIdentityRetirement()
  }, [userId])
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    if (disposeTimer.current !== null) { clearTimeout(disposeTimer.current); disposeTimer.current = null }
    owner.lifecycle.setState((state) => ({ ...state, active: true }))
    return () => {
      retireApplicationOwner(owner)
      const viewer = owner.sessionViewer()
      if (viewer === null) retireTelemetryIdentity.current()
      if (viewer !== undefined && viewer !== owner.userId) void owner.retireDisk().catch(() => undefined)
      disposeTimer.current = setTimeout(() => owner.queryClient.clear(), 0)
    }
  }, [owner])
  return <StoreProvider value={{ owner }}><QueryClientProvider client={owner.queryClient}>{children}</QueryClientProvider></StoreProvider>
}
export function retireApplicationOwner(owner: ApplicationOwner) {
  disposeQueryDiagnostics(owner.queryClient)
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
