import type { QueryClient } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { recordRows, tagValue } from "./data-source"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import { telemetryId } from "./context"

const restored = new WeakMap<object, { snapshot: PersistedClient; start: number; id: string; generation: number }>()
const reads = new WeakMap<object, Array<{ generation: number; eligible: boolean }>>()
export async function observeRestoreRead<T>(operation: () => Promise<T>, persister?: object): Promise<T> {
  const generation = telemetryGeneration(), eligible = isTelemetryEligible()
  const start = performance.now(), id = telemetryId()
  if (eligible) emitTelemetry("cache.restore.start", { request_id: id, start_ms: start, phase: "idb_read", cache_stage: "idb" })
  try {
    const result = await operation()
    if (persister && result != null) {
      const pending = reads.get(persister) ?? []
      pending.push({ generation, eligible })
      if (pending.length > 4) for (const receipt of pending) { receipt.eligible = false; receipt.generation = -1 }
      reads.set(persister, pending.slice(-4))
    }
    if (eligible && generation === telemetryGeneration()) emitTelemetry("cache.restore.finish", { request_id: id, phase: "idb_read", outcome: result == null ? "miss" : "hit", duration_ms: performance.now() - start })
    return result
  } catch (error) {
    if (eligible && generation === telemetryGeneration()) emitTelemetry("cache.restore.finish", { request_id: id, phase: "idb_read", outcome: "error", duration_ms: performance.now() - start })
    throw error
  }
}
export function observeRestoreDecode(persister: object, operation: () => PersistedClient, expectedBuster: string, maxAge: number): PersistedClient {
  const admission = reads.get(persister)?.shift()
  const generation = admission?.generation ?? telemetryGeneration()
  const eligible = (reads.has(persister) ? admission?.eligible === true : isTelemetryEligible()) && generation === telemetryGeneration() && isTelemetryEligible()
  const start = performance.now(), id = telemetryId()
  if (eligible) emitTelemetry("cache.restore.start", { request_id: id, phase: "deserialize", start_ms: start })
  try {
    const snapshot = operation()
    const outcome = snapshot.buster !== expectedBuster ? "buster" : Date.now() - snapshot.timestamp > maxAge || !snapshot.timestamp ? "expired" : "hit"
    if (eligible && generation === telemetryGeneration()) {
      emitTelemetry("cache.restore.finish", { request_id: id, phase: "deserialize", outcome, duration_ms: performance.now() - start, count: snapshot.clientState.queries.length })
      if (outcome === "hit") restored.set(persister, { snapshot, start: performance.now(), id: telemetryId(), generation })
    }
    return snapshot
  } catch (error) {
    if (eligible && generation === telemetryGeneration()) emitTelemetry("cache.restore.finish", { request_id: id, phase: "deserialize", outcome: "error", duration_ms: performance.now() - start })
    throw error
  }
}
export function observeHydration(persister: object, client: QueryClient) {
  const evidence = restored.get(persister)
  restored.delete(persister)
  if (!evidence || !isTelemetryEligible() || evidence.generation !== telemetryGeneration()) return
  let count = 0
  emitTelemetry("cache.restore.start", { request_id: evidence.id, start_ms: evidence.start, phase: "hydrate" })
  for (const restoredQuery of evidence.snapshot.clientState.queries) {
    const query = client.getQueryCache().find({ queryKey: restoredQuery.queryKey, exact: true })
    if (!query || query.state.data !== restoredQuery.state.data || query.state.dataUpdatedAt <= 0) continue
    tagValue(client, query.state.data, "restored_idb")
    const key = query.queryKey
    if (key[0] === "community" && key[1] === "db" && Array.isArray(query.state.data)) recordRows(client, String(key[3]), query.state.data, row => String(row.id ?? row.userId ?? row.channelId ?? row.scopeId), "restored_idb")
    count++
  }
  emitTelemetry("cache.restore.finish", { request_id: evidence.id, phase: "hydrate", source: "restored_idb", outcome: count ? "success" : "miss", count, duration_ms: performance.now() - evidence.start })
}
export function discardHydration(persister: object) { restored.delete(persister); reads.delete(persister) }
