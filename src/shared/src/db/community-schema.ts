import {
  sqliteTable,
  text,
  integer,
  check,
  index,
  unique,
  uniqueIndex,
  primaryKey,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ServerRailEntry } from "../community-server-rail";
import { user } from "./schema";

export const communityServer = sqliteTable(
  "community_server",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    name: text("name").notNull(),
    discriminator: text("discriminator").notNull().default("0000"),
    description: text("description").default(""),
    icon: text("icon"),
    official: integer("official", { mode: "boolean" }).notNull().default(false),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  /* istanbul ignore next -- exercised by real D1 migration/runtime */
  (t) => [
    // Unique server handle `name#discriminator` — the server-segment address
    // anchor, so a ref `/name#disc/...` resolves to exactly one server. Mirrors
    // the user `(name, discriminator)` handle. Source of truth:
    // migration 0079_community_server_discriminator.sql. NOCASE on `name` there
    // so the DB ruler folds identically to resolveServerByNameForMember's
    // `COLLATE NOCASE` lookup (the index/resolver alignment migration 0075
    // established for top-level channel names). Plain `.on()` here can't express
    // COLLATE — the migration is authoritative. No `deletedAt` clause: servers
    // are not soft-deleted (community_server has no deletedAt column), unlike the
    // user index's partial `WHERE deletedAt IS NULL` (0055).
    uniqueIndex("idx_community_server_name_discriminator").on(t.name, t.discriminator),
  ]
);

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
// `type`: text | forum | thread | dm. DMs have server_id + name NULL (no
// server, no name); their two participants are relation='access'
// community_channel_member rows.
export const communityChannel: SQLiteTableWithColumns<any> = sqliteTable(
  "community_channel",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    serverId: text("server_id").references(() => communityServer.id, {
      onDelete: "cascade",
    }),
    categoryId: text("category_id").references(() => communityCategory.id, {
      onDelete: "set null",
    }),
    name: text("name"),
    type: text("type").notNull().default("text"),
    topic: text("topic").default(""),
    position: integer("position").default(0),
    parentChannelId: text("parent_channel_id").references(() => communityChannel.id, {
      onDelete: "cascade",
    }),
    creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
    messageCount: integer("message_count").default(0),
    archived: integer("archived").default(0),
    parentMessageId: text("parent_message_id").references(() => communityMessage.id, {
      onDelete: "cascade",
    }),
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_channel_server_position").on(t.serverId, t.position),
    index("idx_channel_server_last_message").on(t.serverId, t.lastMessageAt),
    index("idx_channel_parent").on(t.parentChannelId),
    index("idx_channel_forum_created")
      .on(t.parentChannelId, desc(t.createdAt), desc(t.id))
      .where(and(eq(t.type, "thread"), eq(t.archived, 0), isNotNull(t.parentMessageId))!),
    // Partial unique — top-level channel names are unique per server.
    // Source of truth: migration 0057_channel_unique_name.sql. Threads
    // (parent_channel_id NOT NULL) are exempt by design.
    uniqueIndex("idx_channel_server_name")
      .on(t.serverId, t.name)
      .where(sql`parent_channel_id IS NULL`),
  ]
);

// 3b. community_channel_member
// Two axes on one table, split by `relation`:
//   - "access" — gates private units: a top-level channel in a PRIVATE
//     category, a forum, or a DM (a DM's two participants are access rows).
//     Public/uncategorized channels imply access via server membership.
//   - "notify" — a child thread's participant (notification) set. A message
//     reaches only the thread's notify members, never its whole parent channel.
// A user may hold BOTH an access and a notify row for the same channel, so the
// unique key is (channel_id, user_id, relation). `source` records how the row
// arose: mention | spoke | added.
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
    relation: text("relation").notNull().default("access"),
    source: text("source").notNull().default("added"),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    addedAt: text("added_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_channel_member").on(t.channelId, t.userId, t.relation),
    index("idx_channel_member_user").on(t.userId),
  ]
);

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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    channelId: text("channel_id")
      .notNull()
      .references(() => communityChannel.id, {
        onDelete: "cascade",
      }),
    // Per-channel monotonic sequence, assigned atomically via
    // `community_message_seq` (see queries/community/message.ts `createMessage`).
    // 0 is a legacy sentinel for pre-migration rows — never addressable by
    // seq. Uniqueness enforced by partial indexes in migration 0052 (excluded
    // here since Drizzle doesn't support partial indexes in the schema DSL).
    seq: integer("seq").notNull().default(0),
    // Back-reference to the friendship an approval card renders (migration
    // 0065). Populated on approval-card DM messages only; null everywhere else.
    // ON DELETE SET NULL — unfriending nulls the card back-ref; the message
    // falls back to its stored text. The partial index
    // idx_message_friendship (friendship_id IS NOT NULL) lives in the migration.
    friendshipId: text("friendship_id").references(
      (): any => communityFriendship.id,
      { onDelete: "set null" }
    ),
    // Client-supplied idempotency key (mutation-idempotency plan). A logical
    // send generates one nonce and REUSES it across retries; the server
    // dedupes on (author_id, client_nonce) BEFORE claiming a seq, so a resend
    // over a response-losing gateway returns the first row instead of inserting
    // a duplicate. NULL = legacy / no-nonce send = today's behavior (never
    // deduped). Partial unique index (author_id, client_nonce) WHERE
    // client_nonce IS NOT NULL lives in the migration (Drizzle DSL can't
    // express partial indexes — same as the seq partial indexes above).
    clientNonce: text("client_nonce"),
  },
  (t) => [
    index("idx_message_channel_created").on(t.channelId, t.createdAt),
    index("idx_message_channel_mention_created").on(
      t.channelId,
      t.mentionType,
      t.createdAt
    ),
  ]
);

// 6. community_message_seq — atomic per-channel sequence counter.
// `nextSeq` holds the most recently issued value, not "the next value to hand
// out" despite the name.
// Because DMs are channels now, the PK is the channel id directly.
export const communityMessageSeq = sqliteTable("community_message_seq", {
  channelId: text("channel_id")
    .primaryKey()
    .references(() => communityChannel.id, { onDelete: "cascade" }),
  nextSeq: integer("next_seq").notNull(),
});

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
    joinedAt: text("joined_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_server_member_server_user").on(t.serverId, t.userId),
    index("idx_server_member_user").on(t.userId),

    index("idx_server_member_server_joined").on(t.serverId, t.joinedAt),
  ]
);

export const communityServerRail = sqliteTable("community_server_rail", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  entries: text("entries", { mode: "json" }).$type<ServerRailEntry[]>().notNull(),
});

export const communityServerFolder = sqliteTable(
  "community_server_folder",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [index("idx_server_folder_user").on(t.userId)]
);

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

export const communityServerInvite = sqliteTable(
  "community_server_invite",
  {
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
  },

  (t) => [index("idx_server_invite_server").on(t.serverId)]
);

// 11. community_friendship
//
// schema-drift: `uq_friendship_active` is a partial unique index over the
// UNORDERED pair — MIN(requester_id, addressee_id), MAX(...) WHERE status IN
// ('pending','accepted') — which Drizzle's index DSL can't express (no
// function-expression column support). It is enforced only in migration
// 0065_unified_friendship_approval.sql; D1 enforces it at runtime. Keep the two
// in sync manually. Drizzle's role for that index here is documentation.
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
    // 'pending' | 'accepted' | 'blocked' | 'denied' | 'superseded' | 'cancelled'.
    // 'denied' / 'superseded' / 'cancelled' are terminal (set `resolvedAt`).
    status: text("status").notNull().default("pending"),
    // Whose owner-approval this row is currently waiting on. Null for
    // human↔human (no gate). In J3 it walks requester-owner → addressee-owner.
    needsOwnerApproval: text("needs_owner_approval").references(() => user.id),
    blockerId: text("blocker_id"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
    // Terminal timestamp for accepted/denied/superseded rows.
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("idx_friendship_addressee_status").on(t.addresseeId, t.status),
    index("idx_friendship_requester_status").on(t.requesterId, t.status),
  ]
);

// A read-state row points to one actual message: id, createdAt and seq align.
// Empty scopes have no row. Erase a pointer by deleting its row, never a now/null pair.
// (userId, channelId) is unique; the unique index is enforced by migration SQL.
export const communityReadState = sqliteTable(
  "community_read_state",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => communityChannel.id, {
        onDelete: "cascade",
      }),
    lastReadAt: text("last_read_at").notNull(),
    lastReadMessageId: text("last_read_message_id"),
    lastReadSeq: integer("last_read_seq").notNull().default(0),
  },
  (t) => [index("idx_read_state_user").on(t.userId)]
);

export const communityReadStateRevision = sqliteTable("community_read_state_revision", {
  userId: text("user_id")
    .primaryKey()
    .references(/* istanbul ignore next -- exercised by real D1 migration/runtime */ () => user.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
});

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

export const communityAttachment = sqliteTable(
  "community_attachment",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    uploaderId: text("uploader_id").notNull(),
    r2Key: text("r2_key").notNull(),
    thumbnailR2Key: text("thumbnail_r2_key"),
    filename: text("filename").notNull(),
    contentType: text("content_type"),
    size: integer("size"),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_attachment_uploader").on(t.uploaderId),
    index("idx_attachment_r2_key").on(t.r2Key),
    index("idx_attachment_thumbnail_r2_key").on(t.thumbnailR2Key),
  ]
);

export const communityMessageAttachment = sqliteTable(
  "community_message_attachment",
  {
    messageId: text("message_id").notNull().references(() => communityMessage.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id").notNull().references(() => communityAttachment.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.attachmentId] }),
    unique("uq_message_attachment_position").on(t.messageId, t.position),
    index("idx_message_attachment_file").on(t.attachmentId, t.messageId),
  ]
);

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
//   - "mention" — explicit @user / @everyone in the message body
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

// One durable row per native app installation. Tokens are encrypted before
// this table boundary; the hash is only a possession check for safe account
// transfer and must never be used as a provider credential.
export const communityPushDevice = sqliteTable(
  "community_push_device",
  {
    id: text("id").primaryKey().$defaultFn(() => "cpd_" + nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    platform: text("platform").notNull(),
    providerEnvironment: text("provider_environment").notNull(),
    providerTokenEncrypted: text("provider_token_encrypted").notNull(),
    providerTokenHash: text("provider_token_hash").notNull(),
    appVersion: text("app_version"),
    lastSeenAt: text("last_seen_at").notNull().$defaultFn(() => new Date().toISOString()),
    disabledAt: text("disabled_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_push_device_installation").on(t.installationId),
    index("idx_push_device_user_active").on(t.userId, t.disabledAt),
    index("idx_push_device_token_hash").on(t.providerTokenHash),
    check("ck_push_device_platform", sql`${t.platform} in ('ios', 'android')`),
    check(
      "ck_push_device_provider_environment",
      sql`${t.providerEnvironment} in ('sandbox', 'production')`,
    ),
    check(
      "ck_push_device_android_environment",
      sql`${t.platform} = 'ios' or ${t.providerEnvironment} = 'production'`,
    ),
    check(
      "ck_push_device_token_hash",
      sql`length(${t.providerTokenHash}) = 64 and ${t.providerTokenHash} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

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

// Retain the last 500 audit events per bot.
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

// 22. community_bot_daily_activity
// Per-bot, per-calendar-day rollup powering the my-bots activity heatmap:
// how many messages the bot HANDLED (woke for) and SENT that day. One row per
// (botId, day); each counter is bumped +1 via an upsert that rides an EXISTING
// write batch (handled → the wake_trigger audit batch; sent → the community
// message insert batch), so there is no new hot-path round-trip. `day` is a
// UTC `YYYY-MM-DD` key computed by a single shared helper so both upserts agree
// on the day boundary. Unlike `user.handledMessageCount` (the lifecycle counter
// this replaces), this is a CALENDAR fact: it is NEVER zeroed on nap/reset and
// never touched by the FSM. Read is the last 30 days per bot (≤30 rows, covered
// by the PK), so no rolling prune is required.
export const communityBotDailyActivity = sqliteTable(
  "community_bot_daily_activity",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    handledCount: integer("handled_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.botId, t.day] })]
);

export const communityBotDailyTokenUsage = sqliteTable(
  "community_bot_daily_token_usage",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheTokens: integer("cache_tokens"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.day] }),
    index("idx_community_bot_daily_token_usage_day").on(t.day),
  ]
);

// Each user owns one mark per message. Human marks remain private; bot marks
// and notes are shared with bots that can read the original message.
// A null updatedAt means the historical last-change time is unknown.
export const communityMessageMark = sqliteTable(
  "community_message_mark",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => communityChannel.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    note: text("note"),
    updatedAt: text("updated_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_mark_user_message").on(t.userId, t.messageId),
    index("idx_mark_user_created").on(t.userId, t.createdAt),
    index("idx_mark_message_user").on(t.messageId, t.userId),
  ]
);

// Post tags belong to the opener message, not its channel or thread.
export const communityMessageTag = sqliteTable(
  "community_message_tag",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    messageId: text("message_id")
      .notNull()
      .references(() => communityMessage.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [
    // Toggle idempotency: adding a tag already present is a no-op, not a
    // duplicate row (mirrors community_message_mark's uq_mark_user_message).
    unique("uq_message_tag").on(t.messageId, t.tag),
    // Tag-first: the read pattern is "find messages with tag X" (the forum
    // ?tag= filter, always applied on top of an already-resolved,
    // membership-gated channel's message set) — never a bare cross-channel
    // tag search (Aigneis #646/#647 red-line: that would hand a bot an
    // existence-probe, "which channels have this tag").
    index("idx_message_tag_tag").on(t.tag, t.messageId),
  ]
);
