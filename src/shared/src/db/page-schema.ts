import { index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { communityAttachment, communityMessage } from "./community-schema";
import { user } from "./schema";

export const communityPage = sqliteTable("community_page", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  archiveAttachmentId: text("archive_attachment_id").notNull().references(() => communityAttachment.id, { onDelete: "restrict" }),
  botId: text("bot_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("uq_community_page_artifact").on(t.artifactId),
  uniqueIndex("uq_community_page_archive").on(t.archiveAttachmentId),
  index("idx_community_page_bot_id").on(t.botId, t.createdAt, t.id),
]);

export const communityMessagePage = sqliteTable("community_message_page", {
  messageId: text("message_id").notNull().references(() => communityMessage.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull().references(() => communityPage.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.messageId, t.pageId] }), index("idx_community_message_page_page").on(t.pageId, t.messageId)]);
