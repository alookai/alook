import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./schema"
import type { BotWebhookProvider } from "../bot-webhook"

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
