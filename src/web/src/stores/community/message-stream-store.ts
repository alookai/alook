import { beginMessageObservation, messageMilestone, disposeMessageObservations } from "@/lib/observability/messages"
import { createStore } from "@tanstack/store"
import {
  getOutboxRetryPayload,
  reduceMessageOverlay,
  type MessageOverlayEvent,
  type MessageOverlayIds,
  emptyMessageOverlay,
  type MessageScope,
  type NewOutboxIntent,
  type OutboxRetryPayload,
  type CanonicalMessage,
} from "@/lib/community/message-stream"

type ScopeEntry = { scope: MessageScope; state: MessageOverlayIds }

type MessageStreamStoreState = {
  entries: ReadonlyMap<string, ScopeEntry>
  nextOrdinal: number
  accept: (scope: MessageScope, intent: Omit<NewOutboxIntent, "localOrdinal">) => boolean
  dispatch: (scope: MessageScope, event: MessageOverlayEvent) => void
  getRetryPayload: (scope: MessageScope, nonce: string) => OutboxRetryPayload | undefined
  removeScope: (scope: MessageScope) => void
  removeServer: (serverId: string) => void
  resetAll: () => void
}
export const EMPTY_STORED = emptyMessageOverlay()

export function messageScopeKey(scope: Pick<MessageScope, "kind" | "id">): string {
  return `${scope.kind}:${scope.id}`
}

function executeEffects(effects: ReturnType<typeof reduceMessageOverlay>["effects"]): void {
  for (const effect of effects) URL.revokeObjectURL(effect.url)
}

export function createMessageStreamStore(readMessages: () => Pick<ReadonlyMap<string, CanonicalMessage>, "get"> = () => new Map(), diagnosticOwner?: object) {
  return createStore({ entries: new Map<string, ScopeEntry>() as ReadonlyMap<string, ScopeEntry>, nextOrdinal: 1 }, ({ setState, get }): Omit<MessageStreamStoreState, "entries" | "nextOrdinal"> => ({

  accept: (scope, intent) => {
    const key = messageScopeKey(scope)
    const current = get()
    const overlay = current.entries.get(key)?.state ?? EMPTY_STORED
    if (overlay.outboxByNonce.has(intent.nonce)) return false
    const transition = reduceMessageOverlay(overlay, {
      type: "submit",
      intent: { ...intent, localOrdinal: current.nextOrdinal },
    })
    beginMessageObservation(diagnosticOwner, intent.nonce, scope.kind)
    const entries = new Map(current.entries)
    entries.set(key, { scope, state: transition.state })
    setState((state) => ({ ...state, ...{ entries, nextOrdinal: current.nextOrdinal + 1 } }))
    executeEffects(transition.effects)
    messageMilestone(diagnosticOwner, intent.nonce, "optimistic", "success")
    return true
  },

  dispatch: (scope, event) => {
    const key = messageScopeKey(scope)
    const current = get()
    const overlay = current.entries.get(key)?.state ?? EMPTY_STORED
    if (event.type === "retry" && overlay.outboxByNonce.has(event.nonce)) beginMessageObservation(diagnosticOwner, event.nonce, scope.kind)
    const applied = event.type === "postAck" ? { type: "wsMessage" as const, message: { ...event.message, clientNonce: event.nonce } } : event
    const transition = reduceMessageOverlay(overlay, applied, readMessages())
    if (transition.state !== overlay) {
      const entries = new Map(current.entries)
      entries.set(key, { scope, state: transition.state })
      setState((state) => ({ ...state, ...{ entries } }))
    }
    executeEffects(transition.effects)
    if (transition.state !== overlay && "nonce" in event) {
      const phase = event.type.startsWith("upload") ? "upload" : event.type === "retry" ? "optimistic" : "ack"
      const failed = ["uploadFailed", "postFail", "terminalReject"].includes(event.type)
      messageMilestone(diagnosticOwner, event.nonce, phase, failed ? "error" : "success", failed || event.type === "postAck")
    } else if (transition.state !== overlay && event.type === "wsMessage" && event.message.clientNonce) {
      messageMilestone(diagnosticOwner, event.message.clientNonce, "ack", "success", true)
    }
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
      effects.push(...reduceMessageOverlay(entry.state, { type: "clear" }).effects)
      entries.delete(key)
      changed = true
    }
    if (changed) setState((state) => ({ ...state, ...{ entries } }))
    executeEffects(effects)
  },

  resetAll: () => {
    const current = get()
    const effects = [...current.entries.values()].flatMap((entry) =>
      reduceMessageOverlay(entry.state, { type: "clear" }).effects)
    setState((state) => ({ ...state, ...{ entries: new Map(), nextOrdinal: 1 } }))
    executeEffects(effects)
    if (diagnosticOwner) disposeMessageObservations(diagnosticOwner)
  },
  }))
}
