import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"
import { telemetryId, currentPageObservation, startPageOperation, finishPageOperation, pageOperationAttributes, type PageOperation, type Action } from "./context"

const restored = new WeakMap<object, { count: number; start: number; id: string; generation: number; operation?: PageOperation }>()
const reads = new WeakMap<object, Array<{ generation: number; eligible: boolean; page?: Action }>>()
export async function observeRestoreRead<T>(read: () => Promise<T>, persister?: object): Promise<T> {
  const generation = telemetryGeneration(), eligible = isTelemetryEligible()
  const start = performance.now(), id = telemetryId(), operation = startPageOperation("cache.restore", { phase: "idb_read", cache_stage: "idb" }, currentPageObservation())
  if (eligible) emitTelemetry("cache.restore.start", { ...pageOperationAttributes(operation), request_id: id, start_ms: start, phase: "idb_read", cache_stage: "idb" })
  try {
    const result = await read()
    if (persister && result != null) {
      const pending = reads.get(persister) ?? []
      pending.push({ generation, eligible, page: operation?.page })
      if (pending.length > 4) for (const receipt of pending) { receipt.eligible = false; receipt.generation = -1 }
      reads.set(persister, pending.slice(-4))
    }
    finishPageOperation(operation, result == null ? "miss" : "hit")
    if (eligible && generation === telemetryGeneration()) emitTelemetry("cache.restore.finish", { ...pageOperationAttributes(operation), request_id: id, phase: "idb_read", outcome: result == null ? "miss" : "hit", duration_ms: performance.now() - start })
    return result
  } catch (error) {
    finishPageOperation(operation, "error")
    if (eligible && generation === telemetryGeneration()) emitTelemetry("cache.restore.finish", { ...pageOperationAttributes(operation), request_id: id, phase: "idb_read", outcome: "error", duration_ms: performance.now() - start })
    throw error
  }
}
export function observeRestoreDecode(persister: object, decode: () => PersistedClient, expectedBuster: string, maxAge: number): PersistedClient {
  const admission = reads.get(persister)?.shift()
  const generation = admission?.generation ?? telemetryGeneration()
  const eligible = (reads.has(persister) ? admission?.eligible === true : isTelemetryEligible()) && generation === telemetryGeneration() && isTelemetryEligible()
  const start = performance.now(), id = telemetryId(), operation = eligible ? startPageOperation("cache.restore", { phase: "deserialize", cache_stage: "idb" }, admission?.page) : undefined
  if (eligible) emitTelemetry("cache.restore.start", { ...pageOperationAttributes(operation), request_id: id, phase: "deserialize", start_ms: start })
  try {
    const snapshot = decode()
    const outcome = snapshot.buster !== expectedBuster ? "buster" : Date.now() - snapshot.timestamp > maxAge || !snapshot.timestamp ? "expired" : "hit"
    finishPageOperation(operation, outcome)
    if (eligible && generation === telemetryGeneration()) {
      emitTelemetry("cache.restore.finish", { ...pageOperationAttributes(operation), request_id: id, phase: "deserialize", outcome, duration_ms: performance.now() - start, count: snapshot.clientState.queries.length })
      if (outcome === "hit") restored.set(persister, { count: snapshot.clientState.queries.length, start: performance.now(), id: telemetryId(), generation, operation: startPageOperation("cache.restore", { phase: "hydrate", cache_stage: "query" }, operation?.page) })
    }
    return snapshot
  } catch (error) {
    finishPageOperation(operation, "error")
    if (eligible && generation === telemetryGeneration()) emitTelemetry("cache.restore.finish", { ...pageOperationAttributes(operation), request_id: id, phase: "deserialize", outcome: "error", duration_ms: performance.now() - start })
    throw error
  }
}
export function observeHydration(persister: object) {
  const evidence = restored.get(persister)
  restored.delete(persister)
  if (!evidence || !isTelemetryEligible() || evidence.generation !== telemetryGeneration()) return
  finishPageOperation(evidence.operation, "success")
  emitTelemetry("cache.restore.start", { ...pageOperationAttributes(evidence.operation), request_id: evidence.id, start_ms: evidence.start, phase: "hydrate" })
  emitTelemetry("cache.restore.finish", { ...pageOperationAttributes(evidence.operation), request_id: evidence.id, phase: "hydrate", outcome: "success", count: evidence.count, duration_ms: performance.now() - evidence.start })
}
export function discardHydration(persister: object) { restored.delete(persister); reads.delete(persister) }
