import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { communityMessage } from "./community-schema";
import { user } from "./schema";

export const communityPage = sqliteTable("community_page", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  messageId: text("message_id").notNull().references(() => communityMessage.id, { onDelete: "cascade" }),
  botId: text("bot_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("uq_community_page_artifact").on(t.artifactId),
  uniqueIndex("uq_community_page_message").on(t.messageId),
  index("idx_community_page_bot_id").on(t.botId),
]);
