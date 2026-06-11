import { z } from "zod";
import { IssueStatus, TASK_TYPES } from "./constants";

// ---------------------------------------------------------------------------
// Task status
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum([
  "queued",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

// ---------------------------------------------------------------------------
// Raw SQL row from agent_task_queue (boundary: DB -> App)
// ---------------------------------------------------------------------------

export const ClaimedTaskRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  runtimeId: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  prompt: z.string(),
  status: z.string(),
  priority: z.coerce.number(),
  result: z.unknown().nullable(),
  context: z.unknown().nullable(),
  type: z.string().default(TASK_TYPES.USER_DM_MESSAGE),
  contextKey: z.string().nullable().optional(),
  sessionId: z.string().nullable(),
  createdAt: z.coerce.date(),
  dispatchedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  error: z.string().nullable(),
  traceId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
});
export type ClaimedTaskRow = z.infer<typeof ClaimedTaskRowSchema>;

// ---------------------------------------------------------------------------
// API wire format — task agent data (embedded in claim response)
// ---------------------------------------------------------------------------

export const ColleagueDataApiSchema = z.object({
  name: z.string(),
  email: z.string(),
  description: z.string(),
  instruction: z.string(),
});

export const TaskAgentDataApiSchema = z.object({
  instructions: z.string(),
  name: z.string(),
  runtime_config: z.record(z.string(), z.unknown()).default({}),
  email_handle: z.string().nullable().optional(),
  email_addresses: z.array(z.string()).default([]),
  user_email: z.string().nullable().optional(),
  user_name: z.string().nullable().optional(),
  colleagues: z.array(ColleagueDataApiSchema).default([]),
});
export type TaskAgentDataApi = z.infer<typeof TaskAgentDataApiSchema>;

// ---------------------------------------------------------------------------
// API wire format — base task (output of taskToResponse)
// ---------------------------------------------------------------------------

export const TaskApiBaseSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  runtime_id: z.string(),
  conversation_id: z.string(),
  workspace_id: z.string(),
  prompt: z.string(),
  status: z.string(),
  priority: z.number(),
  dispatched_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  type: z.string(),
  context_key: z.string().nullable().optional(),
  context: z.unknown().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  parent_task_id: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
});
export type TaskApiBase = z.infer<typeof TaskApiBaseSchema>;

// ---------------------------------------------------------------------------
// API wire format — full task (claim response includes agent + prior session)
// ---------------------------------------------------------------------------

export const TaskSenderApiSchema = z.object({
  name: z.string(),
  email: z.string(),
  is_owner: z.boolean(),
});
export type TaskSenderApi = z.infer<typeof TaskSenderApiSchema>;

export const TaskApiSchema = TaskApiBaseSchema.extend({
  agent: TaskAgentDataApiSchema.nullable().optional(),
  sender: TaskSenderApiSchema.nullable().optional(),
});
export type TaskApi = z.infer<typeof TaskApiSchema>;

// ---------------------------------------------------------------------------
// Heartbeat (lightweight liveness ping, independent of poll)
// ---------------------------------------------------------------------------

export const HeartbeatRequestSchema = z.object({
  daemon_id: z.string().min(1),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const SweepRequestSchema = HeartbeatRequestSchema;
export type SweepRequest = HeartbeatRequest;

// ---------------------------------------------------------------------------
// Poll request/response (replaces heartbeat + per-runtime claim)
// ---------------------------------------------------------------------------

export const PollRequestSchema = z.object({
  daemon_id: z.string().min(1),
  max_tasks: z.number().int().min(1).default(1),
  cli_version: z.string().optional(),
});
export type PollRequest = z.infer<typeof PollRequestSchema>;

export const FileRequestItemSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  request_type: z.enum(["tree", "read"]),
  path: z.string(),
});
export type FileRequestItem = z.infer<typeof FileRequestItemSchema>;

export const PollMeetingItemSchema = z.object({
  id: z.string(),
  meeting_url: z.string(),
  participants: z.array(z.string()),
  workspace_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  title: z.string().optional(),
});
export type PollMeetingItem = z.infer<typeof PollMeetingItemSchema>;

export const PollResponseSchema = z.object({
  tasks: z.array(TaskApiSchema),
  evicted: z.boolean().optional(),
  pending_update: z.object({ version: z.string() }).optional(),
  pending_rescan: z.boolean().optional(),
  file_requests: z.array(FileRequestItemSchema).optional(),
  meetings: z.array(PollMeetingItemSchema).optional(),
});
export type PollResponse = z.infer<typeof PollResponseSchema>;

// ---------------------------------------------------------------------------
// Daemon push messages (server -> daemon WebSocket)
// ---------------------------------------------------------------------------

export const DaemonPushMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.tasks"), tasks: z.array(TaskApiSchema) }),
  z.object({ type: z.literal("daemon.file_requests"), workspaceId: z.string(), requests: z.array(FileRequestItemSchema) }),
  z.object({ type: z.literal("daemon.meetings"), meetings: z.array(PollMeetingItemSchema) }),
  z.object({ type: z.literal("daemon.evict"), workspaceId: z.string() }),
  z.object({ type: z.literal("daemon.update"), version: z.string() }),
  z.object({ type: z.literal("daemon.rescan") }),
  z.object({ type: z.literal("daemon.kill"), workspaceId: z.string(), agentId: z.string().min(1), taskId: z.string(), targetTaskId: z.string() }),
]);
export type DaemonPushMessageType = z.infer<typeof DaemonPushMessageSchema>;

// ---------------------------------------------------------------------------
// Register response
// ---------------------------------------------------------------------------

export const RegisterResponseSchema = z.object({
  runtimes: z.array(z.object({ id: z.string() })),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// ---------------------------------------------------------------------------
// Daemon API request schemas
// ---------------------------------------------------------------------------

export const DaemonRuntimeItemSchema = z.object({
  type: z.string().optional(),
  provider: z.string().optional(),
  runtime_mode: z.string().optional(),
  version: z.string().optional(),
  status: z.string().optional(),
  model: z.string().optional(),
});
export type DaemonRuntimeItem = z.infer<typeof DaemonRuntimeItemSchema>;

export const ActivateTokenRuntimeSchema = z.object({
  type: z.string().min(1),
  version: z.string().optional().default(""),
});
export type ActivateTokenRuntime = z.infer<typeof ActivateTokenRuntimeSchema>;

export const ActivateTokenRequestSchema = z.object({
  token: z.string().min(1),
  hostname: z.string().min(1),
  runtimes: z.array(ActivateTokenRuntimeSchema).min(1),
});
export type ActivateTokenRequest = z.infer<typeof ActivateTokenRequestSchema>;

export const RegisterDaemonRequestSchema = z.object({
  workspace_id: z.string().min(1).optional(),
  daemon_id: z.string().min(1),
  device_name: z.string().optional().default(""),
  cli_version: z.string().optional().default(""),
  workspaces_root: z.string().optional().default(""),
  runtimes: z.array(DaemonRuntimeItemSchema).min(1),
});
export type RegisterDaemonRequest = z.infer<typeof RegisterDaemonRequestSchema>;


export const DeregisterRequestSchema = z.object({
  daemon_id: z.string().min(1),
});
export type DeregisterRequest = z.infer<typeof DeregisterRequestSchema>;


export const CompleteTaskRequestSchema = z.object({
  output: z.string().optional(),
  session_id: z.string().optional(),
  branch_name: z.string().optional(),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequestSchema>;

export const FailTaskRequestSchema = z.object({
  error: z.string().optional().default(""),
});
export type FailTaskRequest = z.infer<typeof FailTaskRequestSchema>;

export const MessageItemSchema = z.object({
  seq: z.number(),
  type: z.string(),
  tool: z.string().optional(),
  call_id: z.string().optional(),
  content: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
});
export type MessageItem = z.infer<typeof MessageItemSchema>;

export const ReportMessagesRequestSchema = z.object({
  messages: z.array(MessageItemSchema),
});
export type ReportMessagesRequest = z.infer<typeof ReportMessagesRequestSchema>;

// ---------------------------------------------------------------------------
// Calendar event schemas
// ---------------------------------------------------------------------------

export const RepeatIntervalSchema = z
  .string()
  .regex(/^\d+(min|hour|day|week|month)$/, {
    message:
      "repeat_interval must match <positive_integer><min|hour|day|week|month>",
  });

export const CreateCalendarEventRequestSchema = z
  .object({
    agent_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().max(20_000).optional(),
    scheduled_at: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "scheduled_at must be a valid ISO datetime",
      }),
    repeat_interval: RepeatIntervalSchema.optional(),
    repeat_stop_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    conversation_id: z.string().optional(),
  })
  .refine(
    (data) =>
      !data.repeat_stop_date || !!data.repeat_interval,
    {
      message: "repeat_stop_date requires repeat_interval",
      path: ["repeat_stop_date"],
    }
  );
export type CreateCalendarEventRequestInput = z.infer<
  typeof CreateCalendarEventRequestSchema
>;

export const UpdateCalendarEventRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().max(20_000).nullable().optional(),
    agent_id: z.string().min(1).optional(),
    scheduled_at: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "scheduled_at must be a valid ISO datetime",
      })
      .optional(),
    repeat_interval: RepeatIntervalSchema.nullable().optional(),
    repeat_stop_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    scope: z.enum(["this", "following"]).optional(),
    occurrence_at: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "occurrence_at must be a valid ISO datetime",
      })
      .optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.agent_id !== undefined ||
      v.scheduled_at !== undefined ||
      v.repeat_interval !== undefined ||
      v.repeat_stop_date !== undefined,
    { message: "at least one field is required" }
  );

export const DeleteCalendarEventRequestSchema = z.object({
  scope: z.enum(["this", "following"]).optional(),
  occurrence_at: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "occurrence_at must be a valid ISO datetime",
    })
    .optional(),
});
export type DeleteCalendarEventRequestInput = z.infer<
  typeof DeleteCalendarEventRequestSchema
>;

export type UpdateCalendarEventRequestInput = z.infer<
  typeof UpdateCalendarEventRequestSchema
>;

export const CalendarEventApiSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  scheduled_at: z.string(),
  occurrence_at: z.string(),
  collapsed_count: z.number().nullable().optional(),
  repeat_interval: z.string().nullable(),
  repeat_stop_at: z.string().nullable(),
  last_triggered_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CalendarEventApi = z.infer<typeof CalendarEventApiSchema>;

// ---------------------------------------------------------------------------
// Issue schemas
// ---------------------------------------------------------------------------

export const IssueStatusSchema = z.enum([
  IssueStatus.TODO,
  IssueStatus.IN_PROGRESS,
  IssueStatus.REVIEW,
  IssueStatus.DONE,
  IssueStatus.CLOSED,
  IssueStatus.CANCELED,
  IssueStatus.FAILED,
]);

export const CreateIssueRequestSchema = z.object({
  agent_id: z.string().min(1).optional(),
  title: z.string().min(1, "title is required").max(200),
  description: z.string().max(20_000).optional().default(""),
});
export type CreateIssueRequestInput = z.infer<typeof CreateIssueRequestSchema>;

export const UpdateIssueRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    status: IssueStatusSchema.optional(),
    agent_id: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.agent_id !== undefined,
    { message: "at least one field is required" }
  );
export type UpdateIssueRequestInput = z.infer<typeof UpdateIssueRequestSchema>;

export const CreateIssueCommentBodySchema = z.object({
  content: z.string().min(1, "content is required").max(20_000),
});
export type CreateIssueCommentBody = z.infer<typeof CreateIssueCommentBodySchema>;

/** @deprecated Use CreateIssueCommentBodySchema instead */
export const CreateIssueCommentRequestSchema = CreateIssueCommentBodySchema;
export type CreateIssueCommentRequestInput = CreateIssueCommentBody;

export const IssueCommentApiSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  workspace_id: z.string(),
  author_type: z.enum(["user", "agent"]),
  author_id: z.string(),
  content: z.string(),
  created_at: z.string(),
});
export type IssueCommentApi = z.infer<typeof IssueCommentApiSchema>;

export const IssueApiSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string().nullable(),
  creator_user_id: z.string(),
  conversation_id: z.string().nullable(),
  latest_task_id: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: IssueStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export type IssueApi = z.infer<typeof IssueApiSchema>;

// ---------------------------------------------------------------------------
// Agent link schemas
// ---------------------------------------------------------------------------

export const CreateAgentLinkRequestSchema = z.object({
  source_agent_id: z.string().min(1, "source_agent_id is required"),
  target_agent_id: z.string().min(1, "target_agent_id is required"),
  instruction: z.string().optional().default(""),
});
export type CreateAgentLinkRequestInput = z.infer<typeof CreateAgentLinkRequestSchema>;

export const UpdateAgentLinkRequestSchema = z.object({
  instruction: z.string(),
});
export type UpdateAgentLinkRequestInput = z.infer<typeof UpdateAgentLinkRequestSchema>;

export const UpsertAgentLinkRequestSchema = z.object({
  target_agent_id: z.string().min(1, "target_agent_id is required"),
  instruction: z.string(),
});
export type UpsertAgentLinkRequestInput = z.infer<typeof UpsertAgentLinkRequestSchema>;

// ---------------------------------------------------------------------------
// Whitelist request schema
// ---------------------------------------------------------------------------

export const AddWhitelistRequestSchema = z.object({
  email: z.string().email(),
});
export type AddWhitelistRequest = z.infer<typeof AddWhitelistRequestSchema>;

// ---------------------------------------------------------------------------
// Agent request schemas
// ---------------------------------------------------------------------------

const RuntimeConfigSchema = z
  .object({ model: z.string().max(100).optional() })
  .passthrough()
  .optional();

export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional().default(""),
  instructions: z.string().optional().default(""),
  runtime_id: z.string().min(1, "runtime_id is required"),
  runtime_config: RuntimeConfigSchema,
  max_concurrent_tasks: z.number().int().optional(),
  email_handle: z.string().optional(),
  avatar_url: z.string().max(2000).nullable().optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    runtime_id: z.string().min(1).optional(),
    runtime_config: RuntimeConfigSchema,
    visibility: z.enum(["public", "private"]).optional(),
    avatar_url: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.instructions !== undefined ||
      v.runtime_id !== undefined ||
      v.runtime_config !== undefined ||
      v.visibility !== undefined ||
      v.avatar_url !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

// ---------------------------------------------------------------------------
// Conversation request schemas
// ---------------------------------------------------------------------------

export const CreateConversationRequestSchema = z.object({
  agent_id: z.string().min(1, "agent_id is required"),
  channel: z.string().optional(),
});
export type CreateConversationRequest = z.infer<
  typeof CreateConversationRequestSchema
>;

// ---------------------------------------------------------------------------
// Message request schema (JSON body only — FormData path is separate)
// ---------------------------------------------------------------------------

export const CreateMessageRequestSchema = z.object({
  content: z.string().min(1, "content is required"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

// Agent-authored DM: the agent's own `role:"assistant"` reply, posted via the
// machine-token daemon route (`alook sync send-dm`). Unlike CreateMessageRequest
// (a user send) this does NOT enqueue a task — it only delivers the message.
export const AgentDmRequestSchema = z.object({
  content: z.string().min(1, "content is required"),
  task_id: z.string().min(1).optional(),
});
export type AgentDmRequest = z.infer<typeof AgentDmRequestSchema>;

// ---------------------------------------------------------------------------
// Email request schemas
// ---------------------------------------------------------------------------

export const EmailAttachmentSchema = z.object({
  key: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().min(1),
});

export const SendEmailRequestSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  to: z.string().min(1, "to is required"),
  subject: z.string().min(1, "subject is required"),
  htmlBody: z.string().default(""),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  attachments: z.array(EmailAttachmentSchema).optional(),
  customAccountId: z.string().optional(),
  from: z.string().email().optional(),
  conversationId: z.string().optional(),
  traceId: z.string().optional(),
  sourceTaskId: z.string().optional(),
});
export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>;

export const UpdateEmailStatusRequestSchema = z.object({
  status: z.enum(["unread", "read", "archived", "sent"]),
});
export type UpdateEmailStatusRequest = z.infer<
  typeof UpdateEmailStatusRequestSchema
>;

export const MeetingInfoSchema = z.object({
  title: z.string(),
  meetingUrl: z.string(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  attendees: z.array(z.object({ name: z.string(), email: z.string() })),
});

export const EmailNotifyRequestSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  r2Key: z.string().min(1),
  from: z.string().min(1),
  to: z.string().optional(),
  subject: z.string(),
  isWhitelisted: z.boolean(),
  forwarded: z.boolean().optional().default(false),
  messageId: z.string().optional().default(""),
  inReplyTo: z.string().optional().default(""),
  references: z.string().optional().default(""),
  meetingInfo: MeetingInfoSchema.nullable().optional(),
  attachments: z.string().optional(),
  traceId: z.string().optional(),
  sourceTaskId: z.string().optional(),
  isInternal: z.boolean().optional().default(false),
  senderConversationId: z.string().optional(),
  senderAgentId: z.string().optional(),
});
export type EmailNotifyRequest = z.infer<typeof EmailNotifyRequestSchema>;

// ---------------------------------------------------------------------------
// Custom Email Account schemas
// ---------------------------------------------------------------------------

export const CreateEmailAccountSchema = z.object({
  emailAddress: z.string().email("valid email required"),
  displayName: z.string().default(""),
  imapHost: z.string().min(1, "IMAP host is required"),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapUsername: z.string().min(1, "IMAP username is required"),
  imapPassword: z.string().min(1, "IMAP password is required"),
  imapTls: z.boolean().default(true),
  smtpHost: z.string().min(1, "SMTP host is required"),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpUsername: z.string().min(1, "SMTP username is required"),
  smtpPassword: z.string().min(1, "SMTP password is required"),
  smtpTls: z.number().int().min(0).max(2).default(1),
  pollIntervalSeconds: z.number().int().min(30).max(3600).default(60),
});
export type CreateEmailAccountRequest = z.infer<typeof CreateEmailAccountSchema>;

export const UpdateEmailAccountSchema = z.object({
  emailAddress: z.string().email().optional(),
  displayName: z.string().optional(),
  imapHost: z.string().min(1).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapUsername: z.string().min(1).optional(),
  imapPassword: z.string().min(1).optional(),
  imapTls: z.boolean().optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUsername: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
  smtpTls: z.number().int().min(0).max(2).optional(),
  pollIntervalSeconds: z.number().int().min(30).max(3600).optional(),
});
export type UpdateEmailAccountRequest = z.infer<typeof UpdateEmailAccountSchema>;

export const TestEmailConnectionSchema = z.object({
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapUsername: z.string().min(1),
  imapPassword: z.string().min(1),
  imapTls: z.boolean().default(true),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpUsername: z.string().min(1),
  smtpPassword: z.string().min(1),
  smtpTls: z.number().int().min(0).max(2).default(1),
});
export type TestEmailConnectionRequest = z.infer<typeof TestEmailConnectionSchema>;

// ---------------------------------------------------------------------------
// Member request schemas
// ---------------------------------------------------------------------------

export const UpdateMemberRequestSchema = z.object({
  global_instruction: z.string().max(50000).trim(),
});
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>;

// ---------------------------------------------------------------------------
// Workspace request schemas
// ---------------------------------------------------------------------------

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1, "name is required"),
  slug: z.string().optional().default(""),
});
export type CreateWorkspaceRequest = z.infer<
  typeof CreateWorkspaceRequestSchema
>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1, "name is required").max(100).trim().optional(),
  slug: z.string().min(1, "slug is required").max(100).trim().toLowerCase().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const DeleteWorkspaceRequestSchema = z.object({
  confirm_name: z.string().min(1, "confirm_name is required"),
});
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;

export const GrantAgentAccessRequestSchema = z.object({
  user_id: z.string().min(1, "user_id is required"),
});
export type GrantAgentAccessRequest = z.infer<typeof GrantAgentAccessRequestSchema>;

// ---------------------------------------------------------------------------
// Workspace file browsing
// ---------------------------------------------------------------------------

export const WorkspaceFileBrowseRequestSchema = z.object({
  request_type: z.enum(["tree", "read"]),
  path: z.string().default("."),
});
export type WorkspaceFileBrowseRequest = z.infer<typeof WorkspaceFileBrowseRequestSchema>;

export const WorkspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  modifiedAt: z.string(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;

export const WorkspaceFileReportSchema = z.object({
  request_id: z.string().min(1),
  entries: z.array(WorkspaceFileEntrySchema).optional(),
  content: z.string().nullable().optional(),
  isBinary: z.boolean().optional(),
  error: z.string().optional(),
  path: z.string(),
});
export type WorkspaceFileReport = z.infer<typeof WorkspaceFileReportSchema>;

// ---------------------------------------------------------------------------
// Workspace skill browsing (V2 — D1 cache)
// ---------------------------------------------------------------------------

export const SkillEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  isGlobal: z.boolean().optional(),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

const SkillItemSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export const SkillSyncRequestSchema = z.object({
  scope: z.enum(["global", "agent"]),
  agent_id: z.string().min(1).optional(),
  daemon_id: z.string().min(1).optional(),
  runtime: z.enum(["claude", "codex", "opencode"]),
  skills: z.array(SkillItemSchema),
});
export type SkillSyncRequest = z.infer<typeof SkillSyncRequestSchema>;

// ---------------------------------------------------------------------------
// Studio onboarding
// ---------------------------------------------------------------------------

export const StudioMemberSchema = z.object({
  name: z.string().optional(),
  role: z.enum(["leader", "researcher", "engineer", "assistant"]),
  runtime_id: z.string().min(1, "runtime_id is required"),
  runtime_config: z.object({ model: z.string().max(100).optional() }).passthrough().optional(),
  description: z.string().optional().default(""),
  instructions: z.string().optional().default(""),
  avatar_url: z.string().max(2000).nullable().optional(),
  email_handle: z.string().max(30).optional(),
  relationship: z.string().optional(),
});

export const CreateStudioRequestSchema = z.object({
  name: z.string().max(100).optional(),
  scenario: z.string().max(50).optional(),
  members: z.array(StudioMemberSchema).min(1).max(4),
}).refine(
  (v) => v.members.some((m) => m.role === "leader"),
  { message: "at least one member must have the leader role" },
);
export type CreateStudioRequest = z.infer<typeof CreateStudioRequestSchema>;

// ---------------------------------------------------------------------------
// Agent recruit schema
// ---------------------------------------------------------------------------

export const RecruitAgentRequestSchema = z.object({
  instructions: z.string().min(1, "instructions is required"),
  relationship: z.string().min(1, "relationship is required"),
  name: z.string().optional(),
  description: z.string().optional().default(""),
  model: z.string().max(100).optional(),
  context_key: z.string().optional(),
});
export type RecruitAgentRequest = z.infer<typeof RecruitAgentRequestSchema>;

export const CreateThreadRequestSchema = z.object({
  parent_message_id: z.string().min(1),
  content: z.string().optional().default(""),
  attachment_ids: z.array(z.string()).optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
