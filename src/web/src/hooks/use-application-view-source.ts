"use client"

import { useLayoutEffect, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { assertApplicationOwner, captureApplicationOwner, useApplicationOwner } from "@/lib/application-owner"

export function useApplicationViewSource(identity: string) {
  const owner = useApplicationOwner()
  const view = useMemo(() => createStore({ owner, identity, active: true, generation: 0, controller: new AbortController() }), [owner, identity])
  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active: true, controller: state.controller.signal.aborted ? new AbortController() : state.controller }))
    const original = view.get().controller
    return () => { view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 })); original.abort() }
  }, [view])
  const signal = useSelector(view, (state) => state.controller.signal)
  return useMemo(() => {
    const capture = () => {
      const token = captureApplicationOwner(owner)
      const generation = view.get().generation
      const assert = () => {
        assertApplicationOwner(token)
        const state = view.get()
        if (!state.active || state.generation !== generation) throw new DOMException("Retired application view", "AbortError")
      }
      return { token, assert, signal: view.get().controller.signal }
    }
    const retire = () => {
      const controller = view.get().controller
      view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      controller.abort()
    }
    return { owner, capture, signal, retire }
  }, [owner, signal, view])
}
