import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { user } from "./schema"
import type {
  BotPrivateInboxDirection,
  BotPrivateInboxSourceKind,
  BotPrivateInboxStatus,
} from "../bot-private-inbox"

export const communityBotPrivateInbox = sqliteTable(
  "community_bot_private_inbox",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    botUserId: text("bot_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<BotPrivateInboxSourceKind>().notNull(),
    sourceId: text("source_id").notNull(),
    sourceRefId: text("source_ref_id"),
    dedupeKey: text("dedupe_key"),
    direction: text("direction").$type<BotPrivateInboxDirection>().notNull().default("inbound"),
    senderId: text("sender_id"),
    senderLabel: text("sender_label"),
    chatLabel: text("chat_label"),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    promptText: text("prompt_text").notNull(),
    status: text("status").$type<BotPrivateInboxStatus>().notNull(),
    lastError: text("last_error"),
    createdAtMs: integer("created_at_ms").notNull(),
    dispatchedAtMs: integer("dispatched_at_ms"),
  },
  (t) => [
    uniqueIndex("uq_community_bot_private_inbox_dedupe")
      .on(t.sourceKind, t.sourceId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index("idx_community_bot_private_inbox_bot_pending").on(t.botUserId, t.status, t.createdAtMs),
    index("idx_community_bot_private_inbox_source_created").on(t.sourceKind, t.sourceId, t.createdAtMs),
    index("idx_community_bot_private_inbox_owner").on(t.ownerUserId),
  ],
)
