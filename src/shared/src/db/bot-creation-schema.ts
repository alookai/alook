import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./schema"
import { communityMessage, communityChannel } from "./community-schema"
import type { BotCreationItem } from "../community-bot-creation"

export const communityBotCreationRequest = sqliteTable("community_bot_creation_request", {
  id: text("id").primaryKey(),
  requesterId: text("requester_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => communityChannel.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull().unique().references(() => communityMessage.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "approved", "declined"] }).notNull().default("pending"),
  bots: text("bots", { mode: "json" }).$type<BotCreationItem[]>().notNull(),
  decisionNonce: text("decision_nonce"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (t) => [index("idx_bot_creation_requester").on(t.requesterId, t.createdAt), index("idx_bot_creation_owner").on(t.ownerId, t.createdAt)])
