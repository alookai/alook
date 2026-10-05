"use client"

import { commandObservation } from "@/lib/observability/context"

import { UnauthorizedError } from "@/lib/errors"
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react"
import { createStore, createStoreContext } from "@tanstack/react-store"
import { reconcileFlagCount } from "@/lib/workspace-flag-count"
import { reconcileChatFlags } from "@/lib/workspace-chat-flags"
import { reconcileWorkspaceIssue } from "@/lib/workspace-issue-reconciliation"
import { reconcileChatMessages } from "@/lib/workspace-chat-reconciliation"
import { reconcileQueryReceipt } from "@/lib/query-receipt"
import type { ApiRequestOptions } from "@/lib/api/client"
import {
  applicationKey, assertApplicationOwner, captureApplicationOwner, invalidateApplicationAuthentication,
  useApplicationOwner, type ApplicationOwner,
} from "@/lib/application-owner"

export function createWorkspaceOwner(application: ApplicationOwner, workspaceId: string, slug: string) {
  application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "chat", "messages"), { structuralSharing: reconcileChatMessages })
  application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "issues", "detail"), { structuralSharing: reconcileWorkspaceIssue })
  application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "chat", "flags"), { structuralSharing: reconcileChatFlags })
  application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "flag-count"), { structuralSharing: reconcileFlagCount })
  application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "email", "entity"), { structuralSharing: reconcileQueryReceipt })
  application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "email", "body"), { structuralSharing: reconcileQueryReceipt })
  for (const resource of ["task", "task-messages", "active-task", "extras"]) application.queryClient.setQueryDefaults(applicationKey(application, "workspace", workspaceId, "chat", resource), { structuralSharing: reconcileQueryReceipt })
  return {
    application, workspaceId, slug,
    queryClient: application.queryClient,
    lifecycle: createStore({ active: true, generation: 0 }),
    key: (...parts: readonly unknown[]) => applicationKey(application, "workspace", workspaceId, ...parts),
  }
}
export type WorkspaceOwner = ReturnType<typeof createWorkspaceOwner>
export function captureWorkspaceOwner(owner: WorkspaceOwner) {
  return { owner, generation: owner.lifecycle.get().generation, application: captureApplicationOwner(owner.application) }
}
export function assertWorkspaceOwner(token: ReturnType<typeof captureWorkspaceOwner>, signal?: AbortSignal) {
  assertApplicationOwner(token.application, signal)
  const state = token.owner.lifecycle.get()
  if (!state.active || state.generation !== token.generation) {
    throw new DOMException("Retired workspace owner", "AbortError")
  }
}
export function workspaceRequestOptions(token: ReturnType<typeof captureWorkspaceOwner>, signal?: AbortSignal, assertActive = () => assertWorkspaceOwner(token, signal)): ApiRequestOptions & { assertActive: () => void } {
  return { observation: commandObservation(token), authenticationAccount: token.owner.application.userId, signal, assertActive, onUnauthorized: () => { assertActive(); return invalidateApplicationAuthentication(token.application, signal) } }
}
export async function runWorkspaceRequest<T>(owner: WorkspaceOwner, load: (options: ApiRequestOptions) => Promise<T>, signal?: AbortSignal) {
  const token = captureWorkspaceOwner(owner)
  assertWorkspaceOwner(token, signal)
  try {
    const data = await load(workspaceRequestOptions(token, signal))
    assertWorkspaceOwner(token, signal)
    return data
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error
    assertWorkspaceOwner(token, signal)
    throw error
  }
}
const { StoreProvider, useStoreContext } = createStoreContext<{ owner: WorkspaceOwner }>()
export const useWorkspaceOwner = () => useStoreContext().owner
export function useWorkspace() {
  const { workspaceId, slug } = useWorkspaceOwner()
  return { workspaceId, slug }
}

export function WorkspaceProvider({ workspaceId, slug, children }: {
  workspaceId: string; slug: string; children: ReactNode,
}) {
  const application = useApplicationOwner()
  return <ScopedWorkspaceProvider key={`${application.userId}:${workspaceId}`} application={application} workspaceId={workspaceId} slug={slug}>
    {children}
  </ScopedWorkspaceProvider>
}
function ScopedWorkspaceProvider({ application, workspaceId, slug, children }: {
  application: ApplicationOwner; workspaceId: string; slug: string; children: ReactNode,
}) {
  const [owner] = useState(() => createWorkspaceOwner(application, workspaceId, slug))
  const [handles] = useState(() => ({ owner }))
  useLayoutEffect(() => {
    owner.lifecycle.setState((state) => state.active ? state : { ...state, active: true })
    return () => {
      owner.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
      void owner.queryClient.cancelQueries({ queryKey: owner.key() })
    }
  }, [owner])
  useEffect(() => {
    // Navigation memory is scoped to the signed-in account; old device-global
    // lastWorkspace is not an authority for this account's selection.
    application.preferences.setState((state) => ({ ...state, lastWorkspaceSlug: slug }))
    try { localStorage.setItem(`alook:${application.userId}:lastWorkspace`, slug) } catch {}
  }, [application.preferences, application.userId, slug])
  return <StoreProvider value={handles}>{children}</StoreProvider>
}
