import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import type { Source } from "./schema"

export type Evidence = { source: Source; version: string; freshness: "restored" | "validated" | "changed" | "unknown"; count: number; wsEventId?: string; wsStart?: number }
type RowEvidence = Evidence & { value: object; fields: Map<string, Source> }
type Diagnostics = { generation: number; revision: number; collections: Map<string, Map<string, RowEvidence>>; empty: Map<string, Evidence>; scope?: Source; origin?: { id: string; start: number }; values: WeakMap<object, Evidence> }
const owners = new WeakMap<QueryClient, Diagnostics>()
const views = new WeakMap<object, { generation: number; evidence: Evidence }>()
let viewRevision = 0
const unknown = (count = 0): Evidence => ({ source: "unknown", version: "unknown", freshness: "unknown", count })
function owner(client: QueryClient) {
  let state = owners.get(client)
  if (!state || state.generation !== telemetryGeneration()) {
    state = { generation: telemetryGeneration(), revision: 0, collections: new Map(), empty: new Map(), values: new WeakMap() }
    owners.set(client, state)
  }
  return state
}
function plain(row: object): Record<string, unknown> { return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))) }
export function mergeEvidence(evidence: readonly Evidence[]): Evidence {
  if (!evidence.length) return unknown()
  const sources = new Set(evidence.map(item => item.source))
  const ws = evidence.filter(item => item.wsStart !== undefined).sort((a,b) => b.wsStart! - a.wsStart!)[0]
  return {
    ...(ws ? { wsEventId: ws.wsEventId, wsStart: ws.wsStart } : {}),
    source: sources.size === 1 ? evidence[0]!.source : "mixed",
    version: evidenceVersion(evidence),
    freshness: evidence.some(item => item.freshness === "unknown") ? "unknown" : evidence.every(item => item.freshness === "restored") ? "restored" : evidence.every(item => item.freshness === "validated") ? "validated" : "changed",
    count: evidence.reduce((sum,item) => sum + item.count, 0),
  }
}
function evidenceVersion(evidence: readonly Evidence[]) {
  let hash = 2166136261
  for (const item of evidence) for (const character of item.version + ":" + item.source + ":" + item.count + ";") hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  return String(evidence.length) + "_" + String(hash)
}
export function withSource<T>(client: QueryClient, source: Source, effect: () => T, origin?: { id: string; start: number }): T {
  if (!isTelemetryEligible()) return effect()
  const state = owner(client), previous = state.scope, previousOrigin = state.origin
  state.scope = source
  state.origin = origin ?? (source === previous ? previousOrigin : undefined)
  try { return effect() } finally { state.scope = previous; state.origin = previousOrigin }
}
export function currentSource(client: QueryClient): Source { return owners.get(client)?.scope ?? "unknown" }
export function recordRows<T extends object>(client: QueryClient, collection: string, rows: readonly T[], getKey: (row: T) => string, source = currentSource(client)) {
  if (!isTelemetryEligible()) return
  const state = owner(client)
  const previous = state.collections.get(collection) ?? new Map<string, RowEvidence>()
  const next = new Map<string, RowEvidence>()
  let changed = 0
  for (const row of rows) {
    const key = getKey(row), old = previous.get(key)
    const value = plain(row)
    if (old && !(source === "restored_idb" && old.source === "unknown")) {
      const prior = plain(old.value)
      if (replaceEqualDeep(prior, value) === prior) {
        const evidence = { ...old, value: row, freshness: source === "network" ? "validated" as const : old.freshness }
        next.set(key, evidence)
        state.values.set(row, evidence)
        continue
      }
    }
    const fields = new Map<string, Source>()
    const prior = old ? plain(old.value) : {}
    for (const field of Object.keys(value)) fields.set(field, old && replaceEqualDeep(prior[field], value[field]) === prior[field] ? old.fields.get(field) ?? "unknown" : source)
    const sources = new Set(fields.values())
    const ws = source === "ws" && state.origin ? { wsEventId: state.origin.id, wsStart: state.origin.start } : sources.has("ws") && old?.wsEventId ? { wsEventId: old.wsEventId, wsStart: old.wsStart } : {}
    const evidence: RowEvidence = { ...ws, value: row, fields, source: sources.size === 1 ? [...sources][0]! : "mixed", version: String(++state.revision), freshness: source === "restored_idb" ? "restored" : "changed", count: 1 }
    next.set(key, evidence)
    state.values.set(row, evidence)
    changed++
  }
  const removed = [...previous.keys()].filter(key => !next.has(key)).length
  state.collections.set(collection, next)
  const oldEmpty = state.empty.get(collection)
  const emptyChanged = !rows.length && (!oldEmpty || oldEmpty.source !== source || previous.size > 0)
  if (emptyChanged) state.empty.set(collection, { ...(source === "ws" && state.origin ? { wsEventId: state.origin.id, wsStart: state.origin.start } : {}), source, version: String(++state.revision), freshness: source === "restored_idb" ? "restored" : "changed", count: 0 })
  else if (rows.length) state.empty.delete(collection)
  if (changed || removed || emptyChanged) emitTelemetry("data.publish", { ws_event_id: state.origin?.id, source, data_version: String(state.revision), changed_count: changed, removed_count: removed, row_count: rows.length, eligibility: "eligible", freshness: source === "restored_idb" ? "restored" : "changed" })
}
export function collectionEvidence(client: QueryClient, collection: string, keys: readonly string[], actual?: readonly object[]): Evidence {
  if (!isTelemetryEligible()) return unknown()
  const state = owner(client), map = state.collections.get(collection)
  if (!keys.length) return state.empty.get(collection) ?? unknown()
  const evidence = keys.map((key,index) => {
    const item = map?.get(key)
    if (!item) return unknown(1)
    if (actual?.[index]) {
      const prior = plain(item.value)
      if (replaceEqualDeep(prior, plain(actual[index]!)) !== prior) return unknown(1)
    }
    return item
  })
  return mergeEvidence(evidence)
}
export function tagValue(client: QueryClient, value: unknown, source: Source, previous?: unknown) {
  if (!isTelemetryEligible() || !value || typeof value !== "object") return
  const state = owner(client), existing = state.values.get(value)
  if (existing && !(source === "restored_idb" && existing.source === "unknown")) { if (source === "network") state.values.set(value, { ...existing, freshness: "validated" }); return }
  const prior = previous && typeof previous === "object" ? state.values.get(previous) : undefined
  state.values.set(value, { ...(source === "ws" && state.origin ? { wsEventId: state.origin.id, wsStart: state.origin.start } : {}), source: prior && prior.source !== source ? "mixed" : source, version: String(++state.revision), freshness: source === "restored_idb" ? "restored" : "changed", count: Array.isArray(value) ? value.length : 1 })
}
export function valueEvidence(client: QueryClient, value: unknown): Evidence { return value && typeof value === "object" ? owner(client).values.get(value) ?? viewEvidence(value) : unknown() }
export function tagView<T extends object>(value: T, evidence: Evidence): T { if (isTelemetryEligible()) views.set(value, { generation: telemetryGeneration(), evidence }); return value }
export function viewEvidence(value: unknown): Evidence {
  if (!value || typeof value !== "object") return unknown()
  const entry = views.get(value)
  return isTelemetryEligible() && entry?.generation === telemetryGeneration() ? entry.evidence : unknown(Array.isArray(value) ? value.length : 1)
}
export function sourceEvidence(value: object, source: Source): Evidence {
  const current = viewEvidence(value)
  if (current.source === source && current.version !== "unknown") return current
  const evidence: Evidence = { source, version: "v_" + String(++viewRevision), freshness: source === "restored_idb" ? "restored" : "changed", count: Array.isArray(value) ? value.length : 1 }
  tagView(value, evidence)
  return evidence
}
export function deriveView<T extends object>(value: T, inputs: readonly Evidence[], count = Array.isArray(value) ? value.length : 1): T {
  return tagView(value, { ...mergeEvidence(inputs), count })
}
export function forgetCollection(client: QueryClient, collection: string) { const state = owners.get(client); state?.collections.delete(collection); state?.empty.delete(collection) }
export function disposeSources(client: QueryClient) { owners.delete(client) }

export function tagNetworkResponse(value: unknown) {
  if (!isTelemetryEligible()) return
  const seen = new WeakSet<object>()
  let budget = 4096
  const visit = (input: unknown, depth: number) => {
    if (!input || typeof input !== "object" || seen.has(input) || depth > 8 || budget-- < 1) return
    seen.add(input)
    sourceEvidence(input, "network")
    for (const child of Object.values(input)) visit(child, depth + 1)
  }
  visit(value, 0)
}
export function observedValueSource(value: unknown): Source {
  const direct = viewEvidence(value)
  if (direct.source !== "unknown") return direct.source
  if (!value || typeof value !== "object") return "unknown"
  const children = Object.values(value).slice(0, 256).filter(child => child && typeof child === "object")
  if (!children.length) return "unknown"
  return mergeEvidence(children.map(viewEvidence)).source
}
