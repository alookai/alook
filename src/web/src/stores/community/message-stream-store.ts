import { createStore } from "@tanstack/store"
import {
  getOutboxRetryPayload,
  reduceMessageOverlay,
  type MessageOverlayEvent,
  type MessageOverlayState,
  type MessageScope,
  type NewOutboxIntent,
  type OutboxRetryPayload,
  type CanonicalMessage,
} from "@/lib/community/message-stream"

type StoredOverlay = { liveIds: readonly string[]; outboxByNonce: MessageOverlayState["outboxByNonce"] }
type ScopeEntry = { scope: MessageScope; state: StoredOverlay }

type MessageStreamStoreState = {
  entries: ReadonlyMap<string, ScopeEntry>
  nextOrdinal: number
  accept: (scope: MessageScope, intent: Omit<NewOutboxIntent, "localOrdinal">) => boolean
  dispatch: (scope: MessageScope, event: MessageOverlayEvent) => void
  getRetryPayload: (scope: MessageScope, nonce: string) => OutboxRetryPayload | undefined
  removeScope: (scope: MessageScope) => void
  removeServer: (serverId: string) => void
  resetAll: () => void
  overlayFor: (scope: MessageScope) => MessageOverlayState
}
export const EMPTY_STORED: StoredOverlay = { liveIds: [], outboxByNonce: new Map() }

export function hydrate(state: StoredOverlay, messages: ReadonlyMap<string, CanonicalMessage>): MessageOverlayState {
  return { liveById: new Map(state.liveIds.flatMap((id) => { const message = messages.get(id); return message ? [[id, message] as const] : [] })), outboxByNonce: state.outboxByNonce }
}

function storeOverlay(state: MessageOverlayState): StoredOverlay {
  return { liveIds: [...state.liveById.keys()], outboxByNonce: state.outboxByNonce }
}

export function messageScopeKey(scope: Pick<MessageScope, "kind" | "id">): string {
  return `${scope.kind}:${scope.id}`
}

function executeEffects(effects: ReturnType<typeof reduceMessageOverlay>["effects"]): void {
  for (const effect of effects) URL.revokeObjectURL(effect.url)
}

export function createMessageStreamStore(readMessages: () => ReadonlyMap<string, CanonicalMessage> = () => new Map()) {
  return createStore({ entries: new Map<string, ScopeEntry>() as ReadonlyMap<string, ScopeEntry>, nextOrdinal: 1 }, ({ setState, get }): Omit<MessageStreamStoreState, "entries" | "nextOrdinal"> => ({

  accept: (scope, intent) => {
    const key = messageScopeKey(scope)
    const current = get()
    const overlay = hydrate(current.entries.get(key)?.state ?? EMPTY_STORED, readMessages())
    if (overlay.outboxByNonce.has(intent.nonce)) return false
    const transition = reduceMessageOverlay(overlay, {
      type: "submit",
      intent: { ...intent, localOrdinal: current.nextOrdinal },
    })
    const entries = new Map(current.entries)
    entries.set(key, { scope, state: storeOverlay(transition.state) })
    setState((state) => ({ ...state, ...{ entries, nextOrdinal: current.nextOrdinal + 1 } }))
    executeEffects(transition.effects)
    return true
  },

  dispatch: (scope, event) => {
    const key = messageScopeKey(scope)
    const current = get()
    const overlay = hydrate(current.entries.get(key)?.state ?? EMPTY_STORED, readMessages())
    const transition = reduceMessageOverlay(overlay, event.type === "postAck" ? { type: "wsMessage", message: { ...event.message, clientNonce: event.nonce } } : event)
    if (transition.state !== overlay) {
      const entries = new Map(current.entries)
      entries.set(key, { scope, state: storeOverlay(transition.state) })
      setState((state) => ({ ...state, ...{ entries } }))
    }
    executeEffects(transition.effects)
  },

  getRetryPayload: (scope, nonce) => {
    const entry = get().entries.get(messageScopeKey(scope))
    return entry ? getOutboxRetryPayload(hydrate(entry.state, readMessages()), nonce) : undefined
  },

  removeScope: (scope) => {
    const key = messageScopeKey(scope)
    const current = get()
    const entry = current.entries.get(key)
    if (!entry) return
    const transition = reduceMessageOverlay(hydrate(entry.state, readMessages()), { type: "clear" })
    const entries = new Map(current.entries)
    entries.delete(key)
    setState((state) => ({ ...state, ...{ entries } }))
    executeEffects(transition.effects)
  },

  removeServer: (serverId) => {
    const current = get()
    const entries = new Map(current.entries)
    const effects: ReturnType<typeof reduceMessageOverlay>["effects"] = []
    let changed = false
    for (const [key, entry] of current.entries) {
      if (entry.scope.kind !== "channel" || entry.scope.serverId !== serverId) continue
      effects.push(...reduceMessageOverlay(hydrate(entry.state, readMessages()), { type: "clear" }).effects)
      entries.delete(key)
      changed = true
    }
    if (changed) setState((state) => ({ ...state, ...{ entries } }))
    executeEffects(effects)
  },

  resetAll: () => {
    const current = get()
    const effects = [...current.entries.values()].flatMap((entry) =>
      reduceMessageOverlay(hydrate(entry.state, readMessages()), { type: "clear" }).effects)
    setState((state) => ({ ...state, ...{ entries: new Map(), nextOrdinal: 1 } }))
    executeEffects(effects)
  },
  overlayFor: (scope) => hydrate(get().entries.get(messageScopeKey(scope))?.state ?? EMPTY_STORED, readMessages()),
  }))
}
