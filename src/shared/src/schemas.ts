import { z } from "zod";
import { TASK_TYPES } from "./constants";

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
  type: z.string().default(TASK_TYPES.USER_DM_MESSAGE),
  contextKey: z.string().nullable().optional(),
  sessionId: z.string().nullable(),
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
  runtime_config: z.record(z.string(), z.unknown()).default({}),
  email_handle: z.string().nullable().optional(),
  user_email: z.string().nullable().optional(),
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
});
export type TaskApiBase = z.infer<typeof TaskApiBaseSchema>;

// ---------------------------------------------------------------------------
// API wire format — full task (claim response includes agent + prior session)
// ---------------------------------------------------------------------------

export const TaskApiSchema = TaskApiBaseSchema.extend({
  agent: TaskAgentDataApiSchema.nullable().optional(),
});
export type TaskApi = z.infer<typeof TaskApiSchema>;

// ---------------------------------------------------------------------------
// Poll request/response (replaces heartbeat + per-runtime claim)
// ---------------------------------------------------------------------------

export const PollRequestSchema = z.object({
  daemon_id: z.string().min(1),
  max_tasks: z.number().int().min(1).default(1),
  cli_version: z.string().optional(),
});
export type PollRequest = z.infer<typeof PollRequestSchema>;

export const PollResponseSchema = z.object({
  tasks: z.array(TaskApiSchema),
  evicted: z.boolean().optional(),
  pending_update: z.object({ version: z.string() }).optional(),
});
export type PollResponse = z.infer<typeof PollResponseSchema>;

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
  workspace_id: z.string().min(1),
  daemon_id: z.string().min(1),
  device_name: z.string().optional().default(""),
  cli_version: z.string().optional().default(""),
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
  repeat_interval: z.string().nullable(),
  repeat_stop_at: z.string().nullable(),
  last_triggered_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CalendarEventApi = z.infer<typeof CalendarEventApiSchema>;

// ---------------------------------------------------------------------------
// Whitelist request schema
// ---------------------------------------------------------------------------

export const AddWhitelistRequestSchema = z.object({
  email: z.string().email(),
});
export type AddWhitelistRequest = z.infer<typeof AddWhitelistRequestSchema>;
