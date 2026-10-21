import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const batches = sqliteTable("batches", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(), signal: text("signal").notNull(),
  receivedAt: integer("received_at").notNull(), bytes: integer("bytes").notNull(), records: integer("records").notNull(),
  raw: text("raw").notNull(),
})

const pointers = () => ({
  batchId: text("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  resourceIndex: integer("resource_index").notNull(), scopeIndex: integer("scope_index").notNull(), recordIndex: integer("record_index").notNull(),
  pageInstanceId: text("page_instance_id").notNull(), sessionId: text("session_id").notNull(),
})

export const spans = sqliteTable("spans", {
  ...pointers(), traceId: text("trace_id").notNull(), spanId: text("span_id").notNull(), parentSpanId: text("parent_span_id").notNull(),
  name: text("name").notNull(), service: text("service").notNull(), startNano: text("start_nano").notNull(), endNano: text("end_nano").notNull(),
}, table => [primaryKey({ columns: [table.traceId, table.spanId] }), index("spans_batch").on(table.batchId), index("spans_time").on(table.startNano), index("spans_page").on(table.pageInstanceId), index("spans_session").on(table.sessionId)])

export const logs = sqliteTable("logs", {
  ...pointers(), id: text("id").primaryKey(), traceId: text("trace_id").notNull(), customTraceId: text("custom_trace_id").notNull(),
  timeNano: text("time_nano").notNull(), eventName: text("event_name").notNull(), summary: text("summary").notNull(),
}, table => [index("logs_batch").on(table.batchId), index("logs_time").on(table.timeNano), index("logs_trace").on(table.traceId), index("logs_custom_trace").on(table.customTraceId), index("logs_page").on(table.pageInstanceId), index("logs_session").on(table.sessionId)])
