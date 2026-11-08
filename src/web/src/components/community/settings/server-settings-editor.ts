"use client"

import { useCallback, useLayoutEffect, useState } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useQueryClient } from "@tanstack/react-query"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"

type Fields = { name: string; desc: string }

export function useServerSettingsEditor({ serverId, name, desc, open, onSave }: Fields & {
  serverId: string; open: boolean; onSave: (name: string, desc: string) => void | Promise<void>
}) {
  const client = useQueryClient()
  const view = useCommunityViewSource(JSON.stringify(["server-settings-editor", serverId]))
  const [scope, setScope] = useState(() => ({ client, serverId,
    store: createStore({ name, desc, baseline: { name, desc }, pending: false }) }))
  if (scope.client !== client || scope.serverId !== serverId) {
    setScope({ client, serverId, store: createStore({ name, desc, baseline: { name, desc }, pending: false }) })
  }
  const store = scope.store
  const state = useSelector(store, (value) => value)
  // The mounted sidebar retains this editor while a save is pending, including
  // dialog close/reopen. Closed, settled editors start fresh on the next open.
  useLayoutEffect(() => {
    if (open || store.get().pending) return
    store.setState((current) => current.name === name && current.desc === desc
      && current.baseline.name === name && current.baseline.desc === desc ? current
      : { ...current, name, desc, baseline: { name, desc } })
  }, [store, open, name, desc, state.pending])
  const setName = useCallback((next: string) => store.setState((current) => ({ ...current, name: next })), [store])
  const setDesc = useCallback((next: string) => store.setState((current) => ({ ...current, desc: next })), [store])
  const cancel = useCallback(() => store.setState((current) => ({ ...current, ...current.baseline })), [store])
  const save = useCallback(async () => {
    const submitted = store.get()
    if (submitted.pending) return false
    const assert = view.capture()
    assert()
    store.setState((current) => ({ ...current, pending: true }))
    try {
      await onSave(submitted.name, submitted.desc)
      assert()
      store.setState((current) => ({ ...current, baseline: { name: submitted.name, desc: submitted.desc } }))
      return true
    } finally {
      store.setState((current) => ({ ...current, pending: false }))
    }
  }, [store, view, onSave])
  return { name: state.name, desc: state.desc, pending: state.pending,
    dirty: state.name !== state.baseline.name || state.desc !== state.baseline.desc,
    setName, setDesc, cancel, save }
}

export type ServerSettingsEditor = ReturnType<typeof useServerSettingsEditor>
