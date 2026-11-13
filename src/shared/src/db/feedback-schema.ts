import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { user } from "./schema";
import { BOT_FEEDBACK_MAX_BYTES } from "../community-feedback";

export const communityBotFeedback = sqliteTable("community_bot_feedback", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  botId: text("bot_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_bot_feedback_owner_created").on(t.ownerId, t.createdAt),
  check("bot_feedback_text_bytes", sql`length(cast(${t.text} as blob)) between 1 and ${sql.raw(String(BOT_FEEDBACK_MAX_BYTES))}`),
]);
