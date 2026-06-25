import {
  sqliteTable,
  text,
  integer,
  index,
  unique,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { user } from "./schema";

// ---------------------------------------------------------------------------
// Community tables — servers, channels, messages, DMs
// ---------------------------------------------------------------------------

// 1. community_server
export const communityServer = sqliteTable("community_server", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  name: text("name").notNull(),
  description: text("description").default(""),
  icon: text("icon"),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// 2. community_category
export const communityCategory = sqliteTable(
  "community_category",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    serverId: text("server_id")
      .notNull()
      .references(() => communityServer.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").default(0),
    private: integer("private").default(0),
  },
  (t) => [unique("uq_category_server_name").on(t.serverId, t.name)]
);

// 3. community_channel
export const communityChannel = sqliteTable(
  "community_channel",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    serverId: text("server_id")
      .notNull()
      .references(() => communityServer.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => communityCategory.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    type: text("type").notNull().default("text"),
    topic: text("topic").default(""),
    position: integer("position").default(0),
    forumTags: text("forum_tags"), // JSON
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_channel_server_position").on(t.serverId, t.position),
    index("idx_channel_server_last_message").on(t.serverId, t.lastMessageAt),
  ]
);

// 4. community_dm_conversation
export const communityDmConversation = sqliteTable(
  "community_dm_conversation",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    user1Id: text("user1_id").references(() => user.id, { onDelete: "set null" }),
    user2Id: text("user2_id").references(() => user.id, { onDelete: "set null" }),
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_dm_conversation_users").on(t.user1Id, t.user2Id),
    index("idx_dm_conversation_user1_last_message").on(t.user1Id, t.lastMessageAt),
    index("idx_dm_conversation_user2_last_message").on(t.user2Id, t.lastMessageAt),
  ]
);

// 5. community_thread
export const communityThread = sqliteTable(
  "community_thread",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    channelId: text("channel_id")
      .notNull()
      .references(() => communityChannel.id, { onDelete: "cascade" }),
    parentMessageId: text("parent_message_id"), // NO FK to avoid circular dependency
    name: text("name").notNull(),
    kind: text("kind").notNull().default("thread"),
    tags: text("tags"),
    creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
    archived: integer("archived").default(0),
    lastMessageAt: text("last_message_at"),
    messageCount: integer("message_count").default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_thread_channel_archived_last_message").on(
      t.channelId,
      t.archived,
      t.lastMessageAt
    ),
    unique("uq_thread_parent_message").on(t.parentMessageId),
  ]
);

// 6. community_message
// CHECK constraint (in migration SQL): exactly one of channelId/dmConversationId/threadId is non-null
export const communityMessage = sqliteTable(
  "community_message",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    type: text("type").notNull().default("default"),
    mentionType: text("mention_type"),
    replyToId: text("reply_to_id"), // Logical reference, no FK
    threadId: text("thread_id").references(() => communityThread.id, {
      onDelete: "cascade",
    }),
    embeds: text("embeds"),
    flags: integer("flags").default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    channelId: text("channel_id").references(() => communityChannel.id, {
      onDelete: "cascade",
    }),
    dmConversationId: text("dm_conversation_id").references(
      () => communityDmConversation.id,
      { onDelete: "cascade" }
    ),
  },
  (t) => [
    index("idx_message_channel_created").on(t.channelId, t.createdAt),
    index("idx_message_channel_mention_created").on(
      t.channelId,
      t.mentionType,
      t.createdAt
    ),
    index("idx_message_dm_created").on(t.dmConversationId, t.createdAt),
    index("idx_message_thread_created").on(t.threadId, t.createdAt),
  ]
);

// 7. community_server_member
export const communityServerMember = sqliteTable(
  "community_server_member",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    serverId: text("server_id")
      .notNull()
      .references(() => communityServer.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member"),
    nickname: text("nickname"),
    railOrder: integer("rail_order").default(0),
    joinedAt: text("joined_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_server_member_server_user").on(t.serverId, t.userId),
    index("idx_server_member_user").on(t.userId),
    index("idx_server_member_user_rail_order").on(t.userId, t.railOrder),
  ]
);

// 8. community_server_folder
export const communityServerFolder = sqliteTable(
  "community_server_folder",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").default(0),
  },
  (t) => [index("idx_server_folder_user_position").on(t.userId, t.position)]
);

// 9. community_server_folder_item
export const communityServerFolderItem = sqliteTable(
  "community_server_folder_item",
  {
    folderId: text("folder_id")
      .notNull()
      .references(() => communityServerFolder.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => communityServer.id, { onDelete: "cascade" }),
    position: integer("position").default(0),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.serverId] }),
    index("idx_server_folder_item_folder_position").on(t.folderId, t.position),
  ]
);

// 10. community_server_invite
export const communityServerInvite = sqliteTable("community_server_invite", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  serverId: text("server_id")
    .notNull()
    .references(() => communityServer.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  token: text("token")
    .unique()
    .notNull()
    .$defaultFn(() => nanoid(32)),
  maxUses: integer("max_uses"),
  uses: integer("uses").default(0),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// 11. community_friendship
export const communityFriendship = sqliteTable(
  "community_friendship",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    requesterId: text("requester_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    addresseeId: text("addressee_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    blockerId: text("blocker_id"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_friendship_requester_addressee").on(t.requesterId, t.addresseeId),
    index("idx_friendship_addressee_status").on(t.addresseeId, t.status),
    index("idx_friendship_requester_status").on(t.requesterId, t.status),
  ]
);

// 12. community_read_state
// CHECK constraint (in migration SQL): exactly one of channelId/dmConversationId/threadId is non-null
// Partial unique indexes will be in migration SQL since Drizzle doesn't support partial indexes
export const communityReadState = sqliteTable(
  "community_read_state",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => communityChannel.id, {
      onDelete: "cascade",
    }),
    dmConversationId: text("dm_conversation_id").references(
      () => communityDmConversation.id,
      { onDelete: "cascade" }
    ),
    threadId: text("thread_id").references(() => communityThread.id, {
      onDelete: "cascade",
    }),
    lastReadAt: text("last_read_at").notNull(),
    lastReadMessageId: text("last_read_message_id"),
  },
  (t) => [index("idx_read_state_user").on(t.userId)]
);

// 13. community_reaction
export const communityReaction = sqliteTable(
  "community_reaction",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    messageId: text("message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_reaction_message_user_emoji").on(t.messageId, t.userId, t.emoji),
    index("idx_reaction_message").on(t.messageId),
  ]
);

// 14. community_attachment
export const communityAttachment = sqliteTable(
  "community_attachment",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    messageId: text("message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    contentType: text("content_type"),
    size: integer("size"),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_attachment_message").on(t.messageId)]
);

// 15. community_pin
export const communityPin = sqliteTable(
  "community_pin",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    channelId: text("channel_id")
      .notNull()
      .references(() => communityChannel.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    pinnedBy: text("pinned_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_pin_channel_message").on(t.channelId, t.messageId),
    index("idx_pin_channel").on(t.channelId),
  ]
);

// 16. community_mention
export const communityMention = sqliteTable(
  "community_mention",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    messageId: text("message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    read: integer("read").default(0),
  },
  (t) => [
    index("idx_mention_user_read").on(t.userId, t.read),
    index("idx_mention_message").on(t.messageId),
  ]
);

// 17. community_user_profile
// NOTE: userId is the PRIMARY KEY, not a separate id
export const communityUserProfile = sqliteTable("community_user_profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  aboutMe: text("about_me").default(""),
  bannerColor: text("banner_color"),
});

// 18. community_notification_setting
// CHECK constraint (in migration SQL): exactly one of serverId/channelId is non-null
// Partial unique indexes will be in migration SQL
export const communityNotificationSetting = sqliteTable(
  "community_notification_setting",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    serverId: text("server_id").references(() => communityServer.id, {
      onDelete: "cascade",
    }),
    channelId: text("channel_id").references(() => communityChannel.id, {
      onDelete: "cascade",
    }),
    level: text("level").notNull().default("all"),
  },
  (t) => [index("idx_notification_setting_user").on(t.userId)]
);

// 19. community_audit_log
export const communityAuditLog = sqliteTable(
  "community_audit_log",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    serverId: text("server_id")
      .notNull()
      .references(() => communityServer.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    changes: text("changes"),
    reason: text("reason"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_audit_log_server_created").on(t.serverId, t.createdAt),
    index("idx_audit_log_server_action").on(t.serverId, t.action),
  ]
);
