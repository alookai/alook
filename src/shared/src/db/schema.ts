import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";

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
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [unique("member_workspace_user").on(t.workspaceId, t.userId)]
);

export const agentRuntime = sqliteTable(
  "agent_runtime",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    daemonId: text("daemon_id").notNull(),
    name: text("name").notNull().default(""),
    runtimeMode: text("runtime_mode").notNull().default("local"),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("offline"),
    deviceInfo: text("device_info").notNull().default(""),
    metadata: text("metadata", { mode: "json" }),
    lastSeenAt: text("last_seen_at"),
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

export const agent = sqliteTable("agent", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
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
  forwardToEmail: text("forward_to_email").default(""),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const agentWhitelist = sqliteTable(
  "agent_whitelist",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [unique("agent_whitelist_agent_email").on(t.agentId, t.email)]
);

export const conversation = sqliteTable("conversation", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agent.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull().default(""),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const message = sqliteTable("message", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversation.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull().default(""),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const agentTaskQueue = sqliteTable(
  "agent_task_queue",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
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
    uniqueIndex("idx_one_pending_per_conversation")
      .on(t.conversationId)
      .where(sql`status IN ('queued', 'dispatched')`),
    index("idx_task_queue_pending")
      .on(t.agentId, t.status)
      .where(sql`status IN ('queued', 'dispatched')`),
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

export const emails = sqliteTable("emails", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  agentId: text("agent_id")
    .notNull()
    .references(() => agent.id, { onDelete: "cascade" }),
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull().default(""),
  r2Key: text("r2_key").notNull(),
  isWhitelisted: integer("is_whitelisted", { mode: "boolean" }).notNull().default(false),
  forwarded: integer("forwarded", { mode: "boolean" }).notNull().default(false),
  htmlBody: text("html_body").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

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
