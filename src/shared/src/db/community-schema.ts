import {
  sqliteTable,
  text,
  integer,
  index,
  unique,
  uniqueIndex,
  primaryKey,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
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
// `type`: text | forum | forum_post | thread | dm. DMs have server_id + name
// NULL (no server, no name); their two participants are relation='access'
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
    // Display-only original title of a forum post, captured verbatim BEFORE
    // `slugify` lossily derives `name` (the addressing slug). `name` stays the
    // single addressing identity; `display_title` only preserves the
    // human-readable original ("Q3 planning / roadmap", not
    // "q3-planning-roadmap") so a future "title as body-heading" render can use
    // it. NEVER an addressing axis: no resolve-by-name reads it, no unique index,
    // duplicates are legal, and it does NOT participate in slug dedupe/bump.
    // Nullable — only forum_post CREATE writes it; threads / top-level channels /
    // legacy rows leave it null.
    displayTitle: text("display_title"),
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
    // Partial unique — top-level channel names are unique per server.
    // Source of truth: migration 0057_channel_unique_name.sql. Threads and
    // forum posts (parent_channel_id NOT NULL) are exempt by design.
    uniqueIndex("idx_channel_server_name")
      .on(t.serverId, t.name)
      .where(sql`parent_channel_id IS NULL`),
    // Partial unique — a forum post's slug (`name`) is its addressing anchor
    // (`/server/forum/<slug>`), so it must be unique WITHIN its parent forum or
    // resolve-by-name goes ambiguous and read/send/ack on the post break. Scoped
    // to `type='forum_post'` ONLY (NOT all children): a thread's name is derived
    // from its root message and is display-only — threads address by
    // `parent_message_id` (uq_community_channel_parent_message, 0052), so
    // duplicate thread names are legal. Source of truth:
    // migration 0078_forum_post_unique_name.sql. Case-sensitive (plain `name`) to
    // match the forum-post resolver + dedupe (getChildChannelByName /
    // dedupeChildChannelSlug use plain `eq`), so the DB ruler folds identically
    // to resolution (the index/resolver alignment migration 0075 established for
    // top-level names). This is what makes pure-create's bump-retry race-safe.
    uniqueIndex("idx_forum_post_parent_name")
      .on(t.parentChannelId, t.name)
      .where(sql`type = 'forum_post'`),
  ]
);

// 3b. community_channel_member
// Two axes on one table, split by `relation`:
//   - "access" — gates private units: a top-level channel in a PRIVATE
//     category, a forum, or a DM (a DM's two participants are access rows).
//     Public/uncategorized channels imply access via server membership.
//   - "notify" — the thread / forum_post participant (notification) set. A
//     message reaches only the unit's notify members; a thread never notifies
//     its whole parent channel, a forum post never notifies the whole server.
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

// 5. community_message
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
// See plans/community-agent-cli-bridge.md design §3. `nextSeq` holds the most
// recently issued value (not "the next value to hand out" despite the name).
// Because DMs are channels now, the PK is the channel id directly.
export const communityMessageSeq = sqliteTable("community_message_seq", {
  channelId: text("channel_id")
    .primaryKey()
    .references(() => communityChannel.id, { onDelete: "cascade" }),
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
    railOrder: integer("rail_order").default(0),
    joinedAt: text("joined_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_server_member_server_user").on(t.serverId, t.userId),
    index("idx_server_member_user").on(t.userId),
    index("idx_server_member_user_rail_order").on(t.userId, t.railOrder),
    // Serves listMembersPaginated's WHERE server_id ORDER BY (joined_at, id).
    index("idx_server_member_server_joined").on(t.serverId, t.joinedAt),
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
  // listServerInvites filters WHERE server_id — without this it full-scans.
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
// Unique (user_id, channel_id) — a plain unique now that channelId is the only
// scope (was two per-scope partial uniques). The unique index lives in the
// migration SQL.
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
    // INVARIANT: === getMessage(lastReadMessageId).createdAt (see table comment).
    lastReadAt: text("last_read_at").notNull(),
    // INVARIANT: non-null whenever the row exists. Route writes through
    // `markReadToMessageBuilder` — never null out.
    lastReadMessageId: text("last_read_message_id"),
    // Shared per-user cursor for humans AND bots (bots ARE users invariant) —
    // and now the SINGLE unread ruler for both (ref/id read-model seq
    // unification): the inbox unread predicate is `EXISTS(message.seq >
    // lastReadSeq)`, the same seq compare the agent inbox uses. Maintained by
    // EVERY read-state writer: `createMessage`'s author watermark, `bumpReadCursor`
    // (agent ack), AND the human read routes
    // (`markReadToMessageBuilder`/`markReadToMessage`/`markAllServerChannelsRead`)
    // — the earlier "humans don't maintain it" gap is closed, or a human's read
    // would never register under the seq predicate.
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
    // migration 0071 also creates
    //   idx_attachment_pending_uploader (uploader_id, target_id)
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
// owner↔bot DM. After migration 0065 the ONLY live `kind` is:
//   - "join_server": another user asked to add the bot to a server they're in
// The former "friend" kind was folded into `community_friendship`
// (needsOwnerApproval column) and its rows deleted by the migration. The table
// name and shape stay; only the Drizzle `kind` union narrows (see `ApprovalKind`
// in queries/community/bot.ts). `serverId` is non-null iff kind="join_server".
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

