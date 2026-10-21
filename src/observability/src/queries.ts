import { and, count, desc, eq, inArray, max, min, or, sql, sum } from "drizzle-orm"
import { InputError, LIMITS } from "./limits"
import { object, recordAt, type ObjectValue } from "./otlp"
import { batches, logs, spans } from "./schema"
import type { Database } from "./store"

export type Filters = { page?: string; session?: string; trace?: string }
export async function listTraces(db: Database, filters: Filters) {
  const rows = await db.select({
    traceId: spans.traceId, startNano: min(spans.startNano), endNano: max(spans.endNano),
    name: min(spans.name), service: min(spans.service), spanCount: count(),
    rootName: max(sql<string>`case when ${spans.parentSpanId} = '' then ${spans.name} else null end`),
  }).from(spans).where(and(
    filters.page ? eq(spans.pageInstanceId, filters.page) : undefined,
    filters.session ? eq(spans.sessionId, filters.session) : undefined,
  )).groupBy(spans.traceId).orderBy(desc(max(spans.endNano))).limit(LIMITS.listRows + 1)
  return {
    items: rows.slice(0, LIMITS.listRows).map(({ rootName, ...row }) => ({ ...row, name: rootName ?? row.name, durationNano: (BigInt(row.endNano!) - BigInt(row.startNano!)).toString() })),
    truncated: rows.length > LIMITS.listRows,
  }
}

export async function listLogs(db: Database, filters: Filters) {
  const rows = await db.select().from(logs).where(and(
    filters.trace ? or(eq(logs.traceId, filters.trace), eq(logs.customTraceId, filters.trace)) : undefined,
    filters.page ? eq(logs.pageInstanceId, filters.page) : undefined,
    filters.session ? eq(logs.sessionId, filters.session) : undefined,
  )).orderBy(desc(logs.timeNano), desc(logs.id)).limit(LIMITS.listRows + 1)
  return { items: rows.slice(0, LIMITS.listRows), truncated: rows.length > LIMITS.listRows }
}

export async function getBatch(db: Database, id: string) {
  const [row] = await db.select().from(batches).where(eq(batches.id, id)).limit(1)
  if (!row) throw new InputError("Retained batch not found", 404)
  return row
}

export async function getLog(db: Database, id: string) {
  const [row] = await db.select().from(logs).where(eq(logs.id, id)).limit(1)
  if (!row) throw new InputError("Retained log not found", 404)
  const batch = await getBatch(db, row.batchId)
  return { index: row, ...recordAt(object(JSON.parse(batch.raw)), "logs", row) }
}

type DetailLimits = { traceSpans: number; traceBytes: number }
export async function getTrace(db: Database, trace: string, limits: DetailLimits = LIMITS) {
  const rows = await db.select().from(spans).where(eq(spans.traceId, trace)).orderBy(spans.startNano, spans.spanId).limit(limits.traceSpans + 1)
  if (!rows.length) throw new InputError("Retained trace not found", 404)
  const selected = rows.slice(0, limits.traceSpans)
  const ids = [...new Set(selected.map(row => row.batchId))]
  const metadata: Array<{ id: string; bytes: number }> = []
  for (let offset = 0; offset < ids.length; offset += 80) {
    metadata.push(...await db.select({ id: batches.id, bytes: batches.bytes }).from(batches).where(inArray(batches.id, ids.slice(offset, offset + 80))))
  }
  const allowed = new Set<string>()
  let totalBytes = 0
  for (const row of metadata) {
    if (totalBytes + row.bytes > limits.traceBytes) continue
    totalBytes += row.bytes
    allowed.add(row.id)
  }
  const documents = new Map<string, ObjectValue>()
  const allowedIds = [...allowed]
  for (let offset = 0; offset < allowedIds.length; offset += 80) {
    const stored = await db.select({ id: batches.id, raw: batches.raw }).from(batches).where(inArray(batches.id, allowedIds.slice(offset, offset + 80)))
    for (const row of stored) documents.set(row.id, object(JSON.parse(row.raw)))
  }
  const resources = new Map<string, { resource: ObjectValue; scopes: Map<number, ObjectValue> }>()
  let spanCount = 0
  for (const row of selected) {
    const document = documents.get(row.batchId)
    if (!document) continue
    const { resource, scope, record } = recordAt(document, "traces", row)
    const key = row.batchId + ":" + row.resourceIndex
    let group = resources.get(key)
    if (!group) {
      group = { resource: { ...resource, scopeSpans: [] }, scopes: new Map() }
      resources.set(key, group)
    }
    let groupedScope = group.scopes.get(row.scopeIndex)
    if (!groupedScope) {
      groupedScope = { ...scope, spans: [] }
      group.scopes.set(row.scopeIndex, groupedScope)
      ;(group.resource.scopeSpans as ObjectValue[]).push(groupedScope)
    }
    ;(groupedScope.spans as ObjectValue[]).push(record)
    spanCount++
  }
  const reasons: string[] = []
  if (rows.length > limits.traceSpans) reasons.push("span limit")
  if (allowed.size < metadata.length) reasons.push("source byte limit")
  if (metadata.length < ids.length || documents.size < allowed.size) reasons.push("retention changed during read")
  return {
    traceId: trace, spanCount, truncated: reasons.length > 0, reasons,
    sourceBytes: totalBytes, sourceBatches: metadata.filter(row => allowed.has(row.id)),
    otlp: { resourceSpans: [...resources.values()].map(group => group.resource) },
  }
}

export async function statistics(db: Database) {
  const [[batch], [span], [log]] = await Promise.all([
    db.select({ batches: count(), rawBytes: sum(batches.bytes), latest: max(batches.receivedAt) }).from(batches),
    db.select({ spans: count() }).from(spans), db.select({ logs: count() }).from(logs),
  ])
  return { ...batch, ...span, ...log, rawBytes: Number(batch.rawBytes ?? 0), limits: LIMITS }
}
