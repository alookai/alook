import { actionAttributes, finishAction, startAction, type Action } from "./context"
import { emitTelemetry, telemetryGeneration } from "./telemetry"
import type { Attributes } from "./schema"

const owners = new WeakMap<object, Map<string, Action>>()
export function beginMessageObservation(owner: object | undefined, nonce: string, kind: "channel" | "dm") {
  if (!owner) return
  let entries = owners.get(owner)
  if (!entries) { entries = new Map(); owners.set(owner, entries) }
  const previous = entries.get(nonce)
  if (previous && !previous.done && previous.generation === telemetryGeneration()) return previous
  const action = startAction(kind === "dm" ? "dm.message.send" : "channel.message.send")
  if (action) {
    entries.set(nonce, action)
    if (entries.size > 256) entries.delete(entries.keys().next().value!)
  }
  return action
}
export function messageObservation(owner: object | undefined, nonce: unknown): Action | undefined {
  const action = owner && typeof nonce === "string" ? owners.get(owner)?.get(nonce) : undefined
  return action?.generation === telemetryGeneration() ? action : undefined
}
export function messageMilestone(owner: object | undefined, nonce: string, phase: Attributes["phase"], outcome: Attributes["outcome"], terminal = false) {
  const action = messageObservation(owner, nonce)
  if (!action) return
  emitTelemetry("message.milestone", { ...actionAttributes(action), phase, outcome, duration_ms: performance.now() - action.start, source: phase === "optimistic" ? "local_mutation" : "unknown" })
  if (terminal) finishAction(action, outcome, { phase })
}
export function disposeMessageObservations(owner: object) {
  for (const action of owners.get(owner)?.values() ?? []) finishAction(action, "cancelled")
  owners.delete(owner)
}
