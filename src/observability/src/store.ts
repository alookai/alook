import { gt, inArray, isNotNull, or, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { LIMITS } from "./limits"
import type { ParsedBatch } from "./otlp"
import { batches, logs, spans } from "./schema"

export const database = (binding: D1Database) => drizzle(binding)
export type Database = ReturnType<typeof database>
type Retention = { retainedBytes: number; retainedBatches: number; retainedRecords: number }
const field = <T>(key: string) => sql<T>`json_extract(value, ${"$." + key})`.as(key)

export async function persistBatch(db: Database, raw: string, bytes: number, parsed: ParsedBatch, retention: Retention = LIMITS) {
  const id = crypto.randomUUID()
  const spanRows = JSON.stringify(parsed.spans)
  const logRows = JSON.stringify(parsed.logs.map((row, index) => ({ ...row, id: `${id}:${index}` })))
  const pointerFields = {
    batchId: sql<string>`${id}`.as("batchId"),
    resourceIndex: field<number>("resourceIndex"), scopeIndex: field<number>("scopeIndex"), recordIndex: field<number>("recordIndex"),
    pageInstanceId: field<string>("pageInstanceId"), sessionId: field<string>("sessionId"),
  }
  const selectedSpans = db.select({
    ...pointerFields, traceId: field<string>("traceId"), spanId: field<string>("spanId"), parentSpanId: field<string>("parentSpanId"),
    name: field<string>("name"), service: field<string>("service"), startNano: field<string>("startNano"), endNano: field<string>("endNano"),
  }).from(sql`json_each(${spanRows})`).where(isNotNull(field<string>("traceId")))
  const selectedLogs = db.select({
    ...pointerFields, id: field<string>("id"), traceId: field<string>("traceId"), customTraceId: field<string>("customTraceId"),
    timeNano: field<string>("timeNano"), eventName: field<string>("eventName"), summary: field<string>("summary"),
  }).from(sql`json_each(${logRows})`)
  const ranked = db.select({
    id: batches.id,
    byteSum: sql<number>`sum(${batches.bytes}) over (order by ${batches.sequence} desc)`.as("byte_sum"),
    recordSum: sql<number>`sum(${batches.records}) over (order by ${batches.sequence} desc)`.as("record_sum"),
    ordinal: sql<number>`row_number() over (order by ${batches.sequence} desc)`.as("ordinal"),
  }).from(batches).as("retention")
  const retired = db.select({ id: ranked.id }).from(ranked).where(or(
    gt(ranked.byteSum, retention.retainedBytes), gt(ranked.recordSum, retention.retainedRecords), gt(ranked.ordinal, retention.retainedBatches),
  ))
  await db.batch([
    db.insert(batches).values({ id, signal: parsed.signal, receivedAt: Date.now(), raw, bytes, records: parsed.records }),
    db.insert(spans).select(selectedSpans).onConflictDoUpdate({
      target: [spans.traceId, spans.spanId],
      set: {
        batchId: sql`excluded.batch_id`, resourceIndex: sql`excluded.resource_index`, scopeIndex: sql`excluded.scope_index`, recordIndex: sql`excluded.record_index`,
        pageInstanceId: sql`excluded.page_instance_id`, sessionId: sql`excluded.session_id`, parentSpanId: sql`excluded.parent_span_id`,
        name: sql`excluded.name`, service: sql`excluded.service`, startNano: sql`excluded.start_nano`, endNano: sql`excluded.end_nano`,
      },
    }),
    db.insert(logs).select(selectedLogs),
    db.delete(batches).where(inArray(batches.id, retired)),
  ])
  return { id, receivedRecords: parsed.records }
}
