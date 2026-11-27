import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { user } from "./schema"
import type { BotWebhookDeliveryStatus, BotWebhookProvider } from "../bot-webhook"

export const communityBotWebhook = sqliteTable(
  "community_bot_webhook",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    botUserId: text("bot_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").$type<BotWebhookProvider>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    signingSecretEnc: text("signing_secret_enc"),
    eventFilterJson: text("event_filter_json"),
    instruction: text("instruction").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastTriggeredAtMs: integer("last_triggered_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("idx_community_bot_webhook_owner_bot").on(t.ownerUserId, t.botUserId, t.createdAtMs),
    index("idx_community_bot_webhook_bot").on(t.botUserId),
  ],
)

export const communityBotWebhookDelivery = sqliteTable(
  "community_bot_webhook_delivery",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => communityBotWebhook.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    botUserId: text("bot_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    externalDeliveryId: text("external_delivery_id"),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    promptText: text("prompt_text").notNull(),
    status: text("status").$type<BotWebhookDeliveryStatus>().notNull(),
    lastError: text("last_error"),
    createdAtMs: integer("created_at_ms").notNull(),
    dispatchedAtMs: integer("dispatched_at_ms"),
  },
  (t) => [
    uniqueIndex("uq_community_bot_webhook_delivery_ext")
      .on(t.webhookId, t.externalDeliveryId)
      .where(sql`${t.externalDeliveryId} IS NOT NULL`),
    index("idx_community_bot_webhook_delivery_bot_pending").on(t.botUserId, t.status, t.createdAtMs),
    index("idx_community_bot_webhook_delivery_webhook_created").on(t.webhookId, t.createdAtMs),
    index("idx_community_bot_webhook_delivery_owner").on(t.ownerUserId),
  ],
)
