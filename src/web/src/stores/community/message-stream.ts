"use client"

import { create } from "zustand"
import {
  emptyMessageOverlay,
  getOutboxRetryPayload,
  reduceMessageOverlay,
  type MessageOverlayEvent,
  type MessageOverlayState,
  type MessageScope,
  type NewOutboxIntent,
  type OutboxRetryPayload,
} from "@/lib/community/message-stream"

type ScopeEntry = { scope: MessageScope; state: MessageOverlayState }

type MessageStreamStoreState = {
  entries: ReadonlyMap<string, ScopeEntry>
  nextOrdinal: number
  accept: (scope: MessageScope, intent: Omit<NewOutboxIntent, "localOrdinal">) => boolean
  dispatch: (scope: MessageScope, event: MessageOverlayEvent) => void
  projectAvatarIdentity: (userId: string, avatar: string, avatarVersion: number) => void
  getRetryPayload: (scope: MessageScope, nonce: string) => OutboxRetryPayload | undefined
  removeScope: (scope: MessageScope) => void
  removeServer: (serverId: string) => void
  resetAll: () => void
}

const EMPTY_OVERLAY = emptyMessageOverlay()

function messageScopeKey(scope: Pick<MessageScope, "kind" | "id">): string {
  return `${scope.kind}:${scope.id}`
}

function executeEffects(effects: ReturnType<typeof reduceMessageOverlay>["effects"]): void {
  for (const effect of effects) URL.revokeObjectURL(effect.url)
}

export const useMessageStreamStore = create<MessageStreamStoreState>((set, get) => ({
  entries: new Map(),
  nextOrdinal: 1,

  accept: (scope, intent) => {
    const key = messageScopeKey(scope)
    const current = get()
    const overlay = current.entries.get(key)?.state ?? EMPTY_OVERLAY
    if (overlay.outboxByNonce.has(intent.nonce)) return false
    const transition = reduceMessageOverlay(overlay, {
      type: "submit",
      intent: { ...intent, localOrdinal: current.nextOrdinal },
    })
    const entries = new Map(current.entries)
    entries.set(key, { scope, state: transition.state })
    set({ entries, nextOrdinal: current.nextOrdinal + 1 })
    executeEffects(transition.effects)
    return true
  },

  dispatch: (scope, event) => {
    const key = messageScopeKey(scope)
    const current = get()
    const overlay = current.entries.get(key)?.state ?? EMPTY_OVERLAY
    const transition = reduceMessageOverlay(overlay, event)
    if (transition.state !== overlay) {
      const entries = new Map(current.entries)
      entries.set(key, { scope, state: transition.state })
      set({ entries })
    }
    executeEffects(transition.effects)
  },

  projectAvatarIdentity: (userId, avatar, avatarVersion) => {
    const current = get()
    const entries = new Map(current.entries)
    let changed = false
    for (const [key, entry] of current.entries) {
      const transition = reduceMessageOverlay(entry.state, {
        type: "identityUpdated",
        userId,
        avatar,
        avatarVersion,
      })
      if (transition.state === entry.state) continue
      entries.set(key, { ...entry, state: transition.state })
      changed = true
    }
    if (changed) set({ entries })
  },

  getRetryPayload: (scope, nonce) => {
    const entry = get().entries.get(messageScopeKey(scope))
    return entry ? getOutboxRetryPayload(entry.state, nonce) : undefined
  },

  removeScope: (scope) => {
    const key = messageScopeKey(scope)
    const current = get()
    const entry = current.entries.get(key)
    if (!entry) return
    const transition = reduceMessageOverlay(entry.state, { type: "clear" })
    const entries = new Map(current.entries)
    entries.delete(key)
    set({ entries })
    executeEffects(transition.effects)
  },

  removeServer: (serverId) => {
    const current = get()
    const entries = new Map(current.entries)
    const effects: ReturnType<typeof reduceMessageOverlay>["effects"] = []
    let changed = false
    for (const [key, entry] of current.entries) {
      if (entry.scope.kind !== "channel" || entry.scope.serverId !== serverId) continue
      effects.push(...reduceMessageOverlay(entry.state, { type: "clear" }).effects)
      entries.delete(key)
      changed = true
    }
    if (changed) set({ entries })
    executeEffects(effects)
  },

  resetAll: () => {
    const current = get()
    const effects = [...current.entries.values()].flatMap((entry) =>
      reduceMessageOverlay(entry.state, { type: "clear" }).effects)
    set({ entries: new Map(), nextOrdinal: 1 })
    executeEffects(effects)
  },
}))

export function getMessageOverlay(scope: MessageScope): MessageOverlayState {
  return useMessageStreamStore.getState().entries.get(messageScopeKey(scope))?.state ?? EMPTY_OVERLAY
}

export function useMessageOverlay(scope: MessageScope): MessageOverlayState {
  const key = messageScopeKey(scope)
  return useMessageStreamStore((state) => state.entries.get(key)?.state ?? EMPTY_OVERLAY)
}
