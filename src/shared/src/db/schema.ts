import {
  sqliteTable,
  text,
  integer,
  index,
  unique,
  primaryKey,
  foreignKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { TASK_TYPES } from "../constants";

// ---------------------------------------------------------------------------
// Better Auth tables
// ---------------------------------------------------------------------------

// NOTE: `ownerUserId` FK is `ON DELETE NO ACTION` (the DB will refuse to delete
// an owner while they still have bot rows). Any future user-delete path MUST
// call `assertNoLiveBots` (see `queries/community/bot.ts`) to fail early with
// a clear error before hitting the FK.
export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    name: text("name").notNull().default(""),
    email: text("email").unique().notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }),
    image: text("image"),
    createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
    isBot: integer("isBot", { mode: "boolean" }).notNull().default(false),
    ownerUserId: text("ownerUserId"),
    deletedAt: text("deletedAt"),
    discriminator: text("discriminator").notNull().default("0000"),
  },
  (t) => [index("idx_user_ownerUserId_isBot").on(t.ownerUserId, t.isBot)]
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    expiresAt: text("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_session_token_expires").on(t.token, t.expiresAt)]
);

export const account = sqliteTable("account", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  idToken: text("idToken"),
  password: text("password"),
  createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
});

// ---------------------------------------------------------------------------
// Application tables
// ---------------------------------------------------------------------------

export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey().$defaultFn(() => "sp_" + nanoid()),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  onboarded: integer("onboarded").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    globalInstruction: text("global_instruction").notNull().default(""),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [unique("member_workspace_user").on(t.workspaceId, t.userId)]
);

export const workspaceInvite = sqliteTable(
  "workspace_invite",
  {
    id: text("id").primaryKey().$defaultFn(() => "inv_" + nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull().$defaultFn(() => nanoid(32)),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
    usedAt: text("used_at"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_workspace_invite_token").on(t.token),
    index("idx_workspace_invite_workspace").on(t.workspaceId),
  ]
);

export const agentAccess = sqliteTable(
  "agent_access",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("agent_access_agent_ws_user").on(t.agentId, t.workspaceId, t.userId),
    index("idx_agent_access_agent_ws").on(t.agentId, t.workspaceId),
    index("idx_agent_access_user").on(t.userId),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const agentPin = sqliteTable(
  "agent_pin",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    unique("agent_pin_agent_ws_user").on(t.agentId, t.workspaceId, t.userId),
    index("idx_agent_pin_ws_user").on(t.workspaceId, t.userId),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const agentSidebarOrder = sqliteTable(
  "agent_sidebar_order",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    unique("agent_sidebar_order_agent_ws_user").on(t.agentId, t.workspaceId, t.userId),
    index("idx_agent_sidebar_order_ws_user").on(t.workspaceId, t.userId),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const machine = sqliteTable(
  "machine",
  {
    daemonId: text("daemon_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    deviceInfo: text("device_info").notNull().default(""),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    pendingUpdateVersion: text("pending_update_version"),
    pendingRescan: integer("pending_rescan", { mode: "boolean" }).default(false),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.daemonId] })]
);

export const agentRuntime = sqliteTable(
  "agent_runtime",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    daemonId: text("daemon_id").notNull(),
    runtimeMode: text("runtime_mode").notNull().default("local"),
    provider: text("provider").notNull(),
    deviceInfo: text("device_info").notNull().default(""),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("agent_runtime_workspace_daemon_provider").on(
      t.workspaceId,
      t.daemonId,
      t.provider
    ),
    index("idx_agent_runtime_workspace_daemon").on(t.workspaceId, t.daemonId),
    index("idx_agent_runtime_daemon_workspace").on(t.daemonId, t.workspaceId),
  ]
);

export const agent = sqliteTable(
  "agent",
  {
    id: text("id").notNull().$defaultFn(() => "ag_" + nanoid(8)),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    avatarUrl: text("avatar_url"),
    runtimeId: text("runtime_id").references(() => agentRuntime.id),
    runtimeMode: text("runtime_mode").notNull().default("local"),
    runtimeConfig: text("runtime_config", { mode: "json" }),
    visibility: text("visibility").notNull().default("private"),
    status: text("status").notNull().default("idle"),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(6),
    ownerId: text("owner_id").references(() => user.id),
    tools: text("tools", { mode: "json" }),
    triggers: text("triggers", { mode: "json" }),
    emailHandle: text("email_handle").unique(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [primaryKey({ columns: [t.id, t.workspaceId] })]
);

export const agentWhitelist = sqliteTable(
  "agent_whitelist",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    email: text("email").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("agent_whitelist_agent_ws_email").on(t.agentId, t.workspaceId, t.email),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const channel = sqliteTable(
  "channel",
  {
    id: text("id").primaryKey().$defaultFn(() => "ch_" + nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("channel_workspace_name").on(t.workspaceId, t.name),
    index("idx_channel_workspace").on(t.workspaceId),
  ]
);

export const conversation = sqliteTable(
  "conversation",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    type: text("type").notNull().default(TASK_TYPES.USER_DM_MESSAGE),
    channel: text("channel").notNull().default("default"),
    parentMessageId: text("parent_message_id"),
    threadTitle: text("thread_title").notNull().default(""),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_conversation_agent_lookup")
      .on(t.workspaceId, t.agentId, t.userId, t.type, t.channel, t.createdAt),
    index("idx_conversation_ws_user").on(t.workspaceId, t.userId, t.createdAt),
    index("idx_conversation_thread").on(t.parentMessageId),
    unique("uq_conversation_parent_message").on(t.parentMessageId, t.workspaceId),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const message = sqliteTable(
  "message",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    taskId: text("task_id"),
    attachmentIds: text("attachment_ids"),
    metadata: text("metadata"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_message_conversation_status").on(t.conversationId, t.status),
  ]
);

export const agentTaskQueue = sqliteTable(
  "agent_task_queue",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id").notNull(),
    runtimeId: text("runtime_id")
      .notNull()
      .references(() => agentRuntime.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    type: text("type").notNull().default(TASK_TYPES.USER_DM_MESSAGE),
    contextKey: text("context_key"),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    result: text("result", { mode: "json" }),
    context: text("context", { mode: "json" }),
    sessionId: text("session_id"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    dispatchedAt: text("dispatched_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    error: text("error"),
    traceId: text("trace_id"),
    parentTaskId: text("parent_task_id"),
  },
  (t) => [
    index("idx_task_queue_pending")
      .on(t.agentId, t.status)
      .where(sql`status IN ('queued', 'dispatched')`),
    index("idx_task_queue_workspace_active")
      .on(t.workspaceId, t.status, t.agentId)
      .where(sql`status IN ('queued', 'dispatched', 'running')`),
    index("idx_task_queue_agent_history")
      .on(t.agentId, t.workspaceId, t.createdAt),
    index("idx_task_queue_conversation_status")
      .on(t.conversationId, t.status),
    index("idx_task_queue_trace").on(t.traceId),
    index("idx_task_queue_parent").on(t.parentTaskId),
    index("idx_task_queue_workspace_type_status").on(t.workspaceId, t.type, t.status),
    index("idx_task_queue_workspace_status_dispatched").on(t.workspaceId, t.status, t.dispatchedAt),
    index("idx_task_queue_inbox").on(t.workspaceId, t.status, t.completedAt),
    index("idx_task_queue_runtime_pending")
      .on(t.workspaceId, t.runtimeId, t.status)
      .where(sql`status IN ('queued', 'dispatched')`),
    index("idx_task_queue_agent_running")
      .on(t.agentId, t.workspaceId, t.status)
      .where(sql`status IN ('dispatched', 'running')`),
    index("idx_task_queue_inbox_convo")
      .on(t.workspaceId, t.status, t.conversationId, t.completedAt)
      .where(sql`status IN ('completed', 'failed') AND parent_task_id IS NULL`),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const issue = sqliteTable(
  "issue",
  {
    id: text("id").primaryKey().$defaultFn(() => "iss_" + nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .references(() => conversation.id, { onDelete: "cascade" }),
    latestTaskId: text("latest_task_id").references(() => agentTaskQueue.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("todo"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("idx_issue_workspace_status_agent").on(t.workspaceId, t.status, t.agentId),
    index("idx_issue_workspace_updated").on(t.workspaceId, t.updatedAt),
    unique("issue_conversation_unique").on(t.conversationId),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const issueComment = sqliteTable(
  "issue_comment",
  {
    id: text("id").primaryKey().$defaultFn(() => "ic_" + nanoid()),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull().default("user"),
    authorId: text("author_id").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_issue_comment_issue").on(t.issueId, t.createdAt),
    index("idx_issue_comment_workspace").on(t.workspaceId, t.issueId),
  ]
);

export const taskMessage = sqliteTable(
  "task_message",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTaskQueue.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull().default(""),
    tool: text("tool").notNull().default(""),
    content: text("content").notNull().default(""),
    callId: text("call_id").notNull().default(""),
    input: text("input", { mode: "json" }),
    output: text("output").notNull().default(""),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_task_message_task_seq").on(t.taskId, t.seq),
    index("idx_task_message_task_created").on(t.taskId, t.createdAt),
  ]
);

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    fromEmail: text("from_email").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull().default(""),
    r2Key: text("r2_key").notNull(),
    isWhitelisted: integer("is_whitelisted", { mode: "boolean" }).notNull().default(false),
    forwarded: integer("forwarded", { mode: "boolean" }).notNull().default(false),
    messageId: text("message_id").notNull().default(""),
    inReplyTo: text("in_reply_to").notNull().default(""),
    references: text("references").notNull().default(""),
    htmlBody: text("html_body").notNull().default(""),
    attachments: text("attachments").notNull().default("[]"),
    status: text("status").notNull().default("unread"),
    direction: text("direction").notNull().default("inbound"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
    index("idx_emails_agent_ws_status").on(t.agentId, t.workspaceId, t.status),
    index("idx_emails_to_direction").on(t.toEmail, t.direction),
    index("idx_emails_from_direction").on(t.fromEmail, t.direction),
    index("idx_emails_message_id").on(t.messageId),
    index("idx_emails_created_at").on(t.createdAt),
  ]
);

export const calendarEvent = sqliteTable(
  "calendar_event",
  {
    id: text("id").primaryKey().$defaultFn(() => "ce_" + nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    scheduledAt: text("scheduled_at").notNull(),
    repeatInterval: text("repeat_interval"),
    repeatStopAt: text("repeat_stop_at"),
    lastTriggeredAt: text("last_triggered_at"),
    exceptions: text("exceptions", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_calendar_event_agent_ws").on(t.agentId, t.workspaceId),
    index("idx_calendar_event_ws_scheduled").on(t.workspaceId, t.scheduledAt),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const artifact = sqliteTable(
  "artifact",
  {
    id: text("id").primaryKey().$defaultFn(() => "art_" + nanoid()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    thumbnailR2Key: text("thumbnail_r2_key"),
    source: text("source").notNull().default("agent"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_artifact_conversation").on(t.conversationId),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const agentEmailAccount = sqliteTable(
  "agent_email_account",
  {
    id: text("id").primaryKey().$defaultFn(() => "aea_" + nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    emailAddress: text("email_address").notNull(),
    displayName: text("display_name").notNull().default(""),

    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull().default(993),
    imapUsername: text("imap_username").notNull(),
    imapPassword: text("imap_password").notNull(),
    imapTls: integer("imap_tls", { mode: "boolean" }).notNull().default(true),

    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull().default(587),
    smtpUsername: text("smtp_username").notNull(),
    smtpPassword: text("smtp_password").notNull(),
    smtpTls: integer("smtp_tls").notNull().default(1),

    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(60),
    lastSyncedUid: text("last_synced_uid").notNull().default("0"),
    lastSyncedAt: text("last_synced_at"),
    status: text("status").notNull().default("active"),
    errorMessage: text("error_message").notNull().default(""),

    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_email_account_agent_ws").on(t.agentId, t.workspaceId),
    unique("email_account_agent_email").on(t.agentId, t.emailAddress),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const meetingSession = sqliteTable(
  "meeting_session",
  {
    id: text("id").primaryKey().$defaultFn(() => "ms_" + nanoid()),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull().default(""),
    meetingUrl: text("meeting_url").notNull(),
    status: text("status").notNull().default("scheduled"),
    fromEmail: text("from_email"),
    isWhitelisted: integer("is_whitelisted", { mode: "boolean" }).notNull().default(true),
    participants: text("participants", { mode: "json" }).$type<string[]>().notNull().default([]),
    scheduledAt: text("scheduled_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    transcriptR2Key: text("transcript_r2_key"),
    summary: text("summary"),
    error: text("error"),
    workerSessionId: text("worker_session_id"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_meeting_session_agent_ws").on(t.agentId, t.workspaceId),
    index("idx_meeting_session_status").on(t.status),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const machineToken = sqliteTable(
  "machine_token",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .references(() => workspace.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    name: text("name").notNull().default(""),
    status: text("status").notNull().default("active"),
    hostname: text("hostname"),
    runtimesJson: text("runtimes_json"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_machine_token").on(t.token)]
);

export const messageFlag = sqliteTable(
  "message_flag",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("message_flag_message_user").on(t.messageId, t.userId),
    index("idx_message_flag_ws_user_created").on(t.workspaceId, t.userId, t.createdAt),
    index("idx_message_flag_message_user").on(t.messageId, t.userId),
  ]
);

// ---------------------------------------------------------------------------
// Workspace file request (ephemeral queue for file browsing)
// ---------------------------------------------------------------------------

export const conversationMap = sqliteTable(
  "conversation_map",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    key: text("key").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("conversation_map_key_workspace").on(t.key, t.workspaceId),
  ]
);

export const agentLink = sqliteTable(
  "agent_link",
  {
    id: text("id").primaryKey().$defaultFn(() => "al_" + nanoid()),
    workspaceId: text("workspace_id").notNull(),
    sourceAgentId: text("source_agent_id").notNull(),
    targetAgentId: text("target_agent_id").notNull(),
    instruction: text("instruction").notNull().default(""),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("agent_link_ws_source_target").on(t.workspaceId, t.sourceAgentId, t.targetAgentId),
    index("idx_agent_link_workspace").on(t.workspaceId),
    foreignKey({
      columns: [t.sourceAgentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.targetAgentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const conversationReadState = sqliteTable(
  "conversation_read_state",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastReadAt: text("last_read_at").notNull().default("1970-01-01T00:00:00.000Z"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("conversation_read_state_conv_user").on(t.conversationId, t.userId),
    index("idx_conversation_read_state_user").on(t.userId),
  ]
);

export const workspaceFileRequest = sqliteTable(
  "workspace_file_request",
  {
    id: text("id").primaryKey().$defaultFn(() => "wfr_" + nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    requestType: text("request_type").notNull(),
    path: text("path").notNull().default("."),
    status: text("status").notNull().default("pending"),
    result: text("result"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_wfr_workspace_status").on(t.workspaceId, t.status),
  ]
);

export const agentSkill = sqliteTable(
  "agent_skill",
  {
    id: text("id").primaryKey().$defaultFn(() => "as_" + nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    daemonId: text("daemon_id"),
    runtime: text("runtime").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    syncedAt: text("synced_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("agent_skill_ws_runtime_name_agent_daemon").on(t.workspaceId, t.runtime, t.name, t.agentId, t.daemonId),
    index("idx_as_workspace_runtime").on(t.workspaceId, t.runtime),
    index("idx_as_agent_runtime").on(t.agentId, t.runtime),
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
  ]
);

export const inboxUnread = sqliteTable(
  "inbox_unread",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id").notNull(),
    taskType: text("task_type").notNull(),
    taskStatus: text("task_status").notNull(),
    taskPrompt: text("task_prompt"),
    completedAt: text("completed_at").notNull(),
    latestMessageId: text("latest_message_id"),
  },
  (t) => [
    unique("inbox_unread_conv_user").on(t.conversationId, t.userId),
    index("idx_inbox_unread_user_ws").on(t.userId, t.workspaceId, t.taskType, t.completedAt),
  ]
);
