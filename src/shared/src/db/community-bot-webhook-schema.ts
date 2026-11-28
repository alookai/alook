import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./schema"
import type {
  BotTriggerCategory,
  BotTriggerTransport,
  BotWebhookProvider,
} from "../bot-webhook"
import type { BotImProvider } from "../im-contract"

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
    category: text("category").$type<BotTriggerCategory>().notNull().default("webhook"),
    transport: text("transport").$type<BotTriggerTransport>().notNull().default("cloud_webhook"),
    tokenHash: text("token_hash").notNull().unique(),
    signingSecretEnc: text("signing_secret_enc"),
    configJson: text("config_json"),
    outboundCredsEnc: text("outbound_creds_enc"),
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

export const communityBotImReplyRef = sqliteTable(
  "community_bot_im_reply_ref",
  {
    botUserId: text("bot_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ref: text("ref").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => communityBotWebhook.id, { onDelete: "cascade" }),
    platform: text("platform").$type<BotImProvider>().notNull(),
    targetJson: text("target_json").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botUserId, t.ref] }),
    index("idx_community_bot_im_reply_ref_trigger_expires").on(t.triggerId, t.expiresAtMs),
    index("idx_community_bot_im_reply_ref_owner").on(t.ownerUserId),
  ],
)
