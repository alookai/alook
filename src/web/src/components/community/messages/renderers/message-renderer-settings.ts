"use client"

import { useCallback, useLayoutEffect, useSyncExternalStore } from "react"
import type { MessageCellPresentation, MessageRendererId } from "./message-cell-types"
import { CurrentMessageCell } from "./current-message-cell"

export type MessageRendererSettings = {
  ready: boolean
  id: MessageRendererId
  component: MessageCellPresentation | null
  pending: MessageRendererId | null
  error: string | null
  storageAvailable: boolean
  revision: number
}
const initial: MessageRendererSettings = { ready: false, id: "current", component: CurrentMessageCell, pending: null, error: null, storageAvailable: true, revision: 0 }
const anonymous = { ...initial, ready: true }
type Entry = { state: MessageRendererSettings; listeners: Set<() => void>; generation: number; initializing: Promise<void> | null; stopStorage?: () => void }
const entries = new Map<string, Entry>()
const loaders: Partial<Record<MessageRendererId, () => Promise<MessageCellPresentation>>> = {
  current: async () => CurrentMessageCell,
  chatscope: async () => (await import("./chatscope-message-cell")).ChatscopeMessageCell,
  lobe: async () => (await import("./lobe-message-cell")).LobeMessageCell,
}
const loaded = new Map<MessageRendererId, Promise<MessageCellPresentation>>()

export function messageRendererStorageKey(accountId: string) {
  return `alook-message-renderer-v1:${encodeURIComponent(accountId)}`
}
function parseMessageRenderer(value: unknown): MessageRendererId {
  return value === "chatscope" || value === "lobe" ? value : "current"
}
export function messageRendererAvailable(id: MessageRendererId) { return !!loaders[id] }
function entry(accountId: string) {
  let result = entries.get(accountId)
  if (!result) {
    result = { state: initial, listeners: new Set(), generation: 0, initializing: null }
    entries.set(accountId, result)
  }
  return result
}
function publish(owner: Entry, patch: Partial<MessageRendererSettings>) {
  owner.state = { ...owner.state, ...patch }
  for (const listener of owner.listeners) listener()
}
function load(id: MessageRendererId) {
  let result = loaded.get(id)
  if (!result) {
    const loader = loaders[id]
    if (!loader) return Promise.reject(new Error("This renderer is not available in this build."))
    result = loader().catch((error: unknown) => { loaded.delete(id); throw error })
    loaded.set(id, result)
  }
  return result
}
async function activate(accountId: string, requested: MessageRendererId, persist: boolean) {
  const owner = entry(accountId)
  const generation = ++owner.generation
  const id = messageRendererAvailable(requested) ? requested : "current"
  publish(owner, { pending: id, error: null })
  try {
    const component = id === "current" ? CurrentMessageCell : await load(id)
    if (owner.generation !== generation) return
    let storageAvailable = owner.state.storageAvailable
    if (persist) {
      try { window.localStorage.setItem(messageRendererStorageKey(accountId), id); storageAvailable = true }
      catch {
        publish(owner, { ready: true, id: "current", component: CurrentMessageCell, pending: null, error: "This device could not save your choice. Current is active.", storageAvailable: false, revision: owner.state.revision + 1 })
        return
      }
    }
    publish(owner, { ready: true, id, component, pending: null, error: null, storageAvailable, revision: owner.state.revision + (owner.state.id === id && owner.state.component === component ? 0 : 1) })
  } catch {
    if (owner.generation !== generation) return
    publish(owner, { ready: true, id, component: null, pending: null, error: "This renderer could not load. Return to Current to continue.", revision: owner.state.revision + 1 })
  }
}
async function initialize(accountId: string) {
  const owner = entry(accountId)
  if (owner.state.ready || owner.initializing) return owner.initializing
  let id: MessageRendererId = "current"
  try { id = parseMessageRenderer(window.localStorage.getItem(messageRendererStorageKey(accountId))) }
  catch { publish(owner, { storageAvailable: false }) }
  owner.initializing = activate(accountId, id, false).finally(() => { owner.initializing = null })
  return owner.initializing
}
export async function selectMessageRenderer(accountId: string, id: MessageRendererId) {
  if (id !== "current") await initialize(accountId)
  return activate(accountId, id, true)
}
export function failMessageRenderer(accountId: string, id: MessageRendererId) {
  const owner = entry(accountId)
  if (owner.state.id !== id || !owner.state.component) return
  publish(owner, { component: null, error: "This renderer could not display a message. Return to Current to continue." })
}
export function useMessageRendererSettings(accountId?: string | null) {
  const subscribe = useCallback((listener: () => void) => {
    if (!accountId) return () => {}
    const owner = entry(accountId)
    owner.listeners.add(listener)
    if (owner.listeners.size === 1) {
      const onStorage = (event: StorageEvent) => {
        try { if (event.storageArea !== window.localStorage) return }
        catch { void activate(accountId, "current", false); return }
        if (event.key !== null && event.key !== messageRendererStorageKey(accountId)) return
        void activate(accountId, parseMessageRenderer(event.newValue), false)
      }
      window.addEventListener("storage", onStorage)
      owner.stopStorage = () => window.removeEventListener("storage", onStorage)
    }
    return () => {
      owner.listeners.delete(listener)
      if (!owner.listeners.size) { owner.stopStorage?.(); owner.stopStorage = undefined }
    }
  }, [accountId])
  const snapshot = useCallback(() => accountId ? entry(accountId).state : anonymous, [accountId])
  const current = useSyncExternalStore(subscribe, snapshot, () => accountId ? initial : anonymous)
  useLayoutEffect(() => { if (accountId) void initialize(accountId) }, [accountId])
  return current
}
