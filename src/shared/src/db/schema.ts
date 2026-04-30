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

export const user = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  name: text("name").notNull().default(""),
  email: text("email").unique().notNull(),
  emailVerified: integer("emailVerified", { mode: "boolean" }),
  image: text("image"),
  createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
});

export const session = sqliteTable("session", {
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
});

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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
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
      .references(() => agentRuntime.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
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
    foreignKey({
      columns: [t.agentId, t.workspaceId],
      foreignColumns: [agent.id, agent.workspaceId],
    }).onDelete("cascade"),
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
  (t) => [index("idx_task_message_task_seq").on(t.taskId, t.seq)]
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
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    name: text("name").notNull().default(""),
    status: text("status").notNull().default("active"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_machine_token").on(t.token)]
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
  (t) => [index("idx_wfr_workspace_status").on(t.workspaceId, t.status)]
);
