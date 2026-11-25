import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { user } from "./schema"
import type { CalendarRunStatus } from "../calendar"

export const communityCalendarEvent = sqliteTable(
  "community_calendar_event",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    startAtMs: integer("start_at_ms").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    timeZone: text("time_zone").notNull(),
    recurrenceJson: text("recurrence_json"),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    nextRunAtMs: integer("next_run_at_ms"),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    sourceMessageId: text("source_message_id").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("idx_community_calendar_event_owner_created").on(t.ownerUserId, t.createdAtMs),
    index("idx_community_calendar_event_owner_next_run")
      .on(t.ownerUserId, t.nextRunAtMs)
      .where(sql`${t.paused} = 0 AND ${t.nextRunAtMs} IS NOT NULL`),
    index("idx_community_calendar_event_creator_id_lookup").on(t.createdByUserId),
  ],
)

export const communityCalendarRun = sqliteTable(
  "community_calendar_run",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => communityCalendarEvent.id, { onDelete: "cascade" }),
    eventVersion: integer("event_version").notNull(),
    botUserId: text("bot_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scheduledAtMs: integer("scheduled_at_ms").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    descriptionSnapshot: text("description_snapshot").notNull(),
    status: text("status").$type<CalendarRunStatus>().notNull(),
    lastError: text("last_error"),
    ackedAtMs: integer("acked_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("uq_community_calendar_run_event_scheduled").on(t.eventId, t.scheduledAtMs),
    index("idx_community_calendar_run_owner_status_scheduled").on(t.ownerUserId, t.status, t.scheduledAtMs),
    index("idx_community_calendar_run_bot_id_lookup").on(t.botUserId),
  ],
)
