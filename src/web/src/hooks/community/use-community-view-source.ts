"use client"

import { useLayoutEffect, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useCommunityMutationOrigin } from "./community-origin"

export function useCommunityViewSource(identity: string, enabled = true) {
  const origin = useCommunityMutationOrigin()
  const view = useMemo(() => createStore({ identity, owner: origin.registry, active: enabled, generation: 0, controller: new AbortController() }), [origin.registry, identity, enabled])
  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active: enabled, controller: state.controller.signal.aborted ? new AbortController() : state.controller }))
    const original = view.get().controller
    return () => { view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 })); original.abort() }
  }, [view, enabled])
  const signal = useSelector(view, (state) => state.controller.signal)
  return useMemo(() => {
    const capture = () => {
      const token = origin.begin().token
      const generation = view.get().generation
      const assert = () => {
        origin.assert(token)
        const state = view.get()
        if (!state.active || state.generation !== generation) throw new DOMException("Retired community view", "AbortError")
      }
      return Object.assign(assert, { signal: view.get().controller.signal })
    }
    const retire = () => {
      const controller = view.get().controller
      view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      controller.abort()
    }
    return { capture, signal, retire }
  }, [origin, signal, view])
}
