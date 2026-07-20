import {
  sqliteTable,
  text,
  integer,
  index,
  unique,
  primaryKey,
  type SQLiteTableWithColumns,
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
    creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [unique("uq_category_server_name").on(t.serverId, t.name)]
);

// 3. community_channel
export const communityChannel: SQLiteTableWithColumns<any> = sqliteTable(
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
    parentChannelId: text("parent_channel_id").references(() => communityChannel.id, {
      onDelete: "cascade",
    }),
    creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
    messageCount: integer("message_count").default(0),
    archived: integer("archived").default(0),
    parentMessageId: text("parent_message_id"),
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_channel_server_position").on(t.serverId, t.position),
    index("idx_channel_server_last_message").on(t.serverId, t.lastMessageAt),
    index("idx_channel_parent").on(t.parentChannelId),
  ]
);

// 3b. community_channel_member
// Explicit per-channel ACCESS membership. Rows exist ONLY for private access
// units — a top-level channel in a PRIVATE category, or a forum_post under a
// private forum (creator + directly-added members). Public/uncategorized
// channels imply access via server membership and store nothing here. Threads
// are the NOTIFICATION dimension, not access — they never get access rows here;
// their notify set lives in `community_thread_participant` below.
export const communityChannelMember = sqliteTable(
  "community_channel_member",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    channelId: text("channel_id")
      .notNull()
      .references(() => communityChannel.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    addedAt: text("added_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_channel_member").on(t.channelId, t.userId),
    index("idx_channel_member_user").on(t.userId),
  ]
);

// 3c. community_thread_participant
// The NOTIFICATION set for a thread OR a forum_post (`community_channel` rows of
// type "thread" or "forum_post"). Despite the table name, it serves both: both
// are the notification dimension, so a message reaches only the unit's
// participants — a thread never notifies its whole parent channel, and a forum
// post (public or private) never notifies the whole server / whole roster, only
// the people actually involved. The FK `threadChannelId` points at
// `communityChannel.id`, which is why a forum_post id fits without a schema
// change. `source` records how the user joined:
//   - "mention" — @-mentioned in the thread/post (within the unit's audience).
//   - "spoke"   — posted a message in the thread/post (a public post enrolls any
//                 server member who proactively sends; a private post's roster
//                 is added separately, see below).
//   - "added"   — added by another participant (thread picker) or, for a private
//                 forum_post, coupled from the access roster on member-add.
// Leaving deletes the row (a later mention/speak re-adds). Admins are NOT
// auto-added — the notify set is exactly its rows. Muting is the OUTER
// channel-header notification level, NOT a column here — add/leave only.
export const communityThreadParticipant = sqliteTable(
  "community_thread_participant",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    threadChannelId: text("thread_channel_id")
      .notNull()
      .references(() => communityChannel.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("mention"),
    addedAt: text("added_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_thread_participant").on(t.threadChannelId, t.userId),
    index("idx_thread_participant_user").on(t.userId),
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

// 5. community_message
// CHECK constraint (in migration SQL): exactly one of channelId/dmConversationId is non-null
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
    // Per-scope (channel or DM) monotonic sequence, assigned atomically via
    // `community_message_seq` (see queries/community/message.ts `createMessage`).
    // 0 is a legacy sentinel for pre-migration rows — never addressable by
    // seq. Uniqueness enforced by partial indexes in migration 0052 (excluded
    // here since Drizzle doesn't support partial indexes in the schema DSL).
    seq: integer("seq").notNull().default(0),
  },
  (t) => [
    index("idx_message_channel_created").on(t.channelId, t.createdAt),
    index("idx_message_channel_mention_created").on(
      t.channelId,
      t.mentionType,
      t.createdAt
    ),
    index("idx_message_dm_created").on(t.dmConversationId, t.createdAt),
  ]
);

// 6. community_message_seq — atomic per-scope sequence counter.
// See plans/community-agent-cli-bridge.md design §3. `nextSeq` holds the most
// recently issued value (not "the next value to hand out" despite the name).
export const communityMessageSeq = sqliteTable("community_message_seq", {
  scopeKey: text("scope_key").primaryKey(), // 'channel:<id>' or 'dm:<id>'
  nextSeq: integer("next_seq").notNull(),
});

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
    .$defaultFn(() => nanoid(10)),
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
//
// INVARIANT: every row here satisfies
//   lastReadMessageId IS NOT NULL
//   AND lastReadAt === getMessage(lastReadMessageId).createdAt
//
// `lastReadAt` is a denormalized cache of the target message's own
// `createdAt` — it exists only so the inbox unread predicate
// (`channel.lastMessageAt > lastReadAt`) stays a single-column comparison.
// It is NEVER the semantic source of truth on its own.
//
// Consequences for writers:
// - If a channel/DM has no messages yet, there is NO row — mass mark-read is
//   a no-op. Never insert `{ lastReadAt: now, lastReadMessageId: null }`. If
//   a future path genuinely needs to erase the pointer, delete the row.
// - Route every write through `markReadToMessageBuilder` /
//   `markReadToMessage` in `queries/community/read-state.ts`. Both take a
//   `message: { id, createdAt }` and enforce alignment by construction. To
//   mark "as of now", fetch the latest message first with
//   `queries.communityMessage.getLatestMessage`; empty → no-op.
//
// CHECK constraint (in migration SQL): exactly one of channelId/dmConversationId is non-null
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
    // INVARIANT: === getMessage(lastReadMessageId).createdAt (see table comment).
    lastReadAt: text("last_read_at").notNull(),
    // INVARIANT: non-null whenever the row exists. Route writes through
    // `markReadToMessageBuilder` — never null out.
    lastReadMessageId: text("last_read_message_id"),
    // Shared per-user cursor for humans AND bots (bots ARE users invariant).
    // Populated by: the author read-watermark upsert inside `createMessage`
    // (every author, bot or human), and `bumpReadCursor` (agent `ack` route
    // only). NOT maintained by the human-only read routes
    // (`markReadToMessageBuilder`/`markReadToMessage`/`markAllServerChannelsRead`)
    // — an explicit, documented gap, see plans/community-agent-cli-bridge.md §4.
    lastReadSeq: integer("last_read_seq").notNull().default(0),
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
//
// `messageId` is nullable — pending rows created by the agent
// `attachment upload` command exist before the send that links them. The
// human-composer path always writes with `messageId` set at insert time (see
// message-handler.ts). `position` is stamped 0-indexed at link time in the
// caller-specified order; NULL on pending rows.
export const communityAttachment = sqliteTable(
  "community_attachment",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    messageId: text("message_id").references(() => communityMessage.id, {
      onDelete: "cascade",
    }),
    uploaderId: text("uploader_id").notNull(),
    kind: text("kind").notNull(), // "channel" | "dm" — threads flatten to "channel"
    targetId: text("target_id").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type"),
    size: integer("size"),
    width: integer("width"),
    height: integer("height"),
    position: integer("position"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // (message_id, position) matches ORDER BY position on the read path.
    // Drizzle can't express a partial index for the pending lookup here, so
    // migration 0059 also creates
    //   idx_attachment_pending_uploader (uploader_id, kind, target_id)
    //     WHERE message_id IS NULL
    // which the send-time validation query uses.
    index("idx_attachment_message").on(t.messageId, t.position),
  ]
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
// `kind` distinguishes how the mention was created:
//   - "mention" — explicit @user / @everyone / @here in the message body
//   - "reply"   — message replies to one of the user's earlier messages
// The Mentions tab only surfaces kind="mention"; the For You tab uses both.
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
    kind: text("kind").notNull().default("mention"),
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
  // Custom status (emoji + short term) — e.g. "🎧" + "Vibing". Both nullable:
  // no row / null columns means "no status set". See migration 0056.
  statusEmoji: text("status_emoji"),
  statusText: text("status_text").default(""),
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
    // Nullable — bot-lifecycle rows (created/updated/deleted, friend approval)
    // have no server scope. See migration 0050.
    serverId: text("server_id").references(() => communityServer.id, {
      onDelete: "cascade",
    }),
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
    index("idx_audit_log_actor_created").on(t.actorId, t.createdAt),
  ]
);

// 20. community_bot_approval_request
// Represents pending/resolved approval workflows a bot owner sees in the
// owner↔bot DM. `kind` distinguishes the two flows:
//   - "join_server": another user asked to add the bot to a server they're in
//   - "friend": another user sent a friend request to the bot
// `serverId` is non-null iff `kind = "join_server"` (application-enforced).
export const communityBotApprovalRequest = sqliteTable(
  "community_bot_approval_request",
  {
    id: text("id").primaryKey().$defaultFn(() => "bar_" + nanoid()),
    botId: text("bot_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    serverId: text("server_id").references(() => communityServer.id, {
      onDelete: "cascade",
    }),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dmMessageId: text("dm_message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    resolvedAt: text("resolved_at"),
  },
  (t) => [index("idx_community_bot_approval_bot").on(t.botId, t.status)]
);

// 21. community_bot_activity_event
// Per-bot audit trail. Rows are one of three kinds — cli_invocation, tool_call,
// thinking — recorded from the daemon (via the WS control channel) and stamped
// with `createdAt` server-side by ws-do. `payload` is JSON whose shape depends
// on `kind` (see AuditLogPayloadSchema in ../schemas.ts). Retention is a rolling
// last 500 rows per bot, pruned at write time in ws-do.
export const communityBotActivityEvent = sqliteTable(
  "community_bot_activity_event",
  {
    id: text("id").primaryKey().$defaultFn(() => "bae_" + nanoid()),
    botId: text("bot_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    launchId: text("launch_id"),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // Migration 0058 writes this as `(bot_id, created_at DESC, id DESC)` to
    // match the read ORDER BY + retention prune (see plan §Retention).
    // Drizzle's TS-side index type doesn't carry direction; the composite
    // shape at this level is enough for Drizzle's own use — SQLite can walk
    // the index in either direction, and the migration is authoritative on
    // the direction the planner picks.
    index("idx_bot_activity_event_bot_created").on(t.botId, t.createdAt, t.id),
  ]
);

