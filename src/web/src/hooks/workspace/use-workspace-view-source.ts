"use client"

import { useMemo, useLayoutEffect } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"

export function useWorkspaceViewSource(owner: WorkspaceOwner, identity: string, enabled: boolean) {
  const view = useMemo(() => createStore({ owner, identity, active: enabled, generation: 0, controller: new AbortController() }), [owner, identity, enabled])
  const generation = useSelector(view, (state) => state.generation)
  const workspaceGeneration = useSelector(owner.lifecycle, (state) => state.generation)
  const applicationGeneration = useSelector(owner.application.lifecycle, (state) => state.generation)
  const active = useSelector(view, (state) => state.active)
  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active: enabled, controller: state.controller.signal.aborted ? new AbortController() : state.controller }))
    const original = view.get().controller
    return () => {
      view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      original.abort()
    }
  }, [owner, view, enabled])
  const assertActive = useMemo(() => {
    const token = { owner, generation: workspaceGeneration, application: { owner: owner.application, generation: applicationGeneration } }
    return () => {
      assertWorkspaceOwner(token)
      const state = view.get()
      if (!state.active || state.generation !== generation) throw new DOMException("Retired workspace view", "AbortError")
    }
  }, [owner, view, generation, workspaceGeneration, applicationGeneration])
  const factOrigin = useMemo(() => ({ owner, generation: workspaceGeneration, application: { owner: owner.application, generation: applicationGeneration } }), [owner, workspaceGeneration, applicationGeneration])
  const assertFactActive = useMemo(() => () => assertWorkspaceOwner(factOrigin), [factOrigin])
  return useMemo(() => {
  const retire = () => {
    const controller = view.get().controller
    view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
    controller.abort()
  }
  const capture = () => {
    const token = captureWorkspaceOwner(owner), state = view.get(), signal = state.controller.signal
    const assert = () => {
      assertWorkspaceOwner(token, signal)
      const current = view.get()
      if (!current.active || current.generation !== state.generation) throw new DOMException("Retired workspace view", "AbortError")
    }
    return { token, assert, signal }
  }
  return { view, signal: view.get().controller.signal, active, generation, assertActive, assertFactActive, capture, retire, request: (signal?: AbortSignal, assert = assertFactActive) => workspaceRequestOptions(factOrigin, signal, assert) }
  }, [active, generation, assertActive, assertFactActive, factOrigin, owner, view])
}
