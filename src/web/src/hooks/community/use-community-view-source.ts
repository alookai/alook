"use client"

import { useConversationActivity } from "@/contexts/view-activity"
import { useLayoutEffect, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useCommunityMutationOrigin, useCommunityOnlineAccount } from "./community-origin"
import { isAbortError } from "@/lib/errors"

export function useCommunityViewSource(identity: string, enabled = true) {
  enabled = useConversationActivity() && enabled
  const origin = useCommunityMutationOrigin()
  const onlineAccount = useCommunityOnlineAccount()
  const active = enabled && onlineAccount
  const view = useMemo(() => createStore({ identity, owner: origin.registry, active, generation: 0, controller: new AbortController() }), [origin.registry, identity, active])
  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active, controller: state.controller.signal.aborted ? new AbortController() : state.controller }))
    const original = view.get().controller
    return () => { view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 })); original.abort() }
  }, [view, active])
  const signal = useSelector(view, (state) => state.controller.signal)
  return useMemo(() => {
    const capture = () => {
      const token = origin.begin().token
      const generation = view.get().generation
      const assertOwner = () => {
        origin.assertOwner(token)
        const state = view.get()
        if (!state.active || state.generation !== generation) throw new DOMException("Retired community view", "AbortError")
      }
      const assert = () => { origin.assert(token); assertOwner() }
      return Object.assign(assert, { signal: view.get().controller.signal, assertOwner })
    }
    const retire = () => {
      const controller = view.get().controller
      view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      controller.abort()
    }
    const tryCapture = () => {
      if (!onlineAccount || !origin.registry?.isOnlineAccount()) return
      try {
        const assert = capture()
        assert()
        return assert
      } catch (error) {
        if (!isAbortError(error)) throw error
      }
    }
    return { capture, tryCapture, online: onlineAccount, signal, retire }
  }, [onlineAccount, origin, signal, view])
}
