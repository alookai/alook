import { z } from "zod";

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
  sessionId: z.string().nullable(),
  workDir: z.string().nullable(),
  createdAt: z.coerce.date(),
  dispatchedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  error: z.string().nullable(),
});
export type ClaimedTaskRow = z.infer<typeof ClaimedTaskRowSchema>;

// ---------------------------------------------------------------------------
// API wire format — task agent data (embedded in claim response)
// ---------------------------------------------------------------------------

export const TaskAgentDataApiSchema = z.object({
  instructions: z.string(),
  name: z.string(),
  runtime_config: z.record(z.unknown()).default({}),
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
});
export type TaskApiBase = z.infer<typeof TaskApiBaseSchema>;

// ---------------------------------------------------------------------------
// API wire format — full task (claim response includes agent + prior session)
// ---------------------------------------------------------------------------

export const TaskApiSchema = TaskApiBaseSchema.extend({
  agent: TaskAgentDataApiSchema.nullable().optional(),
  prior_session_id: z.string().nullable().optional(),
  prior_work_dir: z.string().nullable().optional(),
});
export type TaskApi = z.infer<typeof TaskApiSchema>;

// ---------------------------------------------------------------------------
// Claim task response
// ---------------------------------------------------------------------------

export const ClaimTaskResponseSchema = z.object({
  task: TaskApiSchema.nullable(),
});
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponseSchema>;

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
  name: z.string().optional(),
  version: z.string().optional(),
  status: z.string().optional(),
  model: z.string().optional(),
});
export type DaemonRuntimeItem = z.infer<typeof DaemonRuntimeItemSchema>;

export const RegisterDaemonRequestSchema = z.object({
  workspace_id: z.string().min(1),
  daemon_id: z.string().min(1),
  device_name: z.string().optional().default(""),
  cli_version: z.string().optional().default(""),
  runtimes: z.array(DaemonRuntimeItemSchema).min(1),
});
export type RegisterDaemonRequest = z.infer<typeof RegisterDaemonRequestSchema>;

export const DeregisterRequestSchema = z.object({
  runtime_ids: z.array(z.string()).default([]),
});
export type DeregisterRequest = z.infer<typeof DeregisterRequestSchema>;

export const HeartbeatRequestSchema = z.object({
  runtime_id: z.string().min(1, "runtime_id is required"),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const CompleteTaskRequestSchema = z.object({
  output: z.string().optional(),
  session_id: z.string().optional(),
  work_dir: z.string().optional(),
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
  content: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  output: z.string().optional(),
});
export type MessageItem = z.infer<typeof MessageItemSchema>;

export const ReportMessagesRequestSchema = z.object({
  messages: z.array(MessageItemSchema),
});
export type ReportMessagesRequest = z.infer<typeof ReportMessagesRequestSchema>;
