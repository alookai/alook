import { RuntimeModelDiscoveryRequestSchema, RuntimeModelDiscoveryErrorSchema } from "./runtime-models-contract";
import { z } from "zod";
import { BOT_MODEL_NAME_MAX_LENGTH } from "./community/bot-model";
import { DiagnosticReportIdSchema } from "./diagnostics-contract";
import { AGENT_EVENT_PROMPT_MAX_LENGTH, BOT_AUDIT_TEXT_MAX_BYTES } from "./community-cli-contract";
import {
  DAILY_TOKEN_USAGE_WINDOW_DAYS,
  DailyUsageSnapshotSchema,
  ProviderQuotaSnapshotListSchema,
  ProviderQuotaSnapshotSchema,
} from "./provider-telemetry";
import {
  ALLOWED_ICON_MIME_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_PROFILE_ABOUT_LENGTH,
  MAX_SERVER_ICON_SIZE_BYTES,
} from "./constants/community";

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

export const TaskSenderApiSchema = z.object({
  name: z.string(),
  email: z.string(),
  is_owner: z.boolean(),
});

export const TaskApiSchema = TaskApiBaseSchema.extend({
  agent: TaskAgentDataApiSchema.nullable().optional(),
  sender: TaskSenderApiSchema.nullable().optional(),
});
export type TaskApi = z.infer<typeof TaskApiSchema>;

export const COMMUNITY_RUNTIME_ID_MAX = 64;
export const COMMUNITY_RUNTIME_VERSION_MAX = 64;
export const COMMUNITY_RUNTIME_LIST_MAX = 64;

const MeetingTimeSchema = z.iso.datetime()
  .transform(value => new Date(value).toISOString())
  .nullable();

export const MeetingInfoSchema = z.object({
  title: z.string(),
  meetingUrl: z.string(),
  startTime: MeetingTimeSchema,
  endTime: MeetingTimeSchema,
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

export const WorkspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  modifiedAt: z.string(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;

// Runtime id charset: alnum + `._@/-`. Length capped at 64 to match the
// on-wire, on-disk, and DB expectations. Version optional, length-capped.
const RUNTIME_ID_RE = /^[A-Za-z0-9._@/-]+$/;
const REASONING_EFFORT_RE = /^[A-Za-z0-9._-]+$/;
export const COMMUNITY_REASONING_EFFORT_MAX = 32;
export const COMMUNITY_REASONING_DESCRIPTION_MAX = 256;
export const COMMUNITY_REASONING_OPTIONS_MAX = 16;
export const COMMUNITY_REASONING_MODELS_MAX = 1024;

export const ReasoningEffortSchema = z
  .string()
  .min(1)
  .max(COMMUNITY_REASONING_EFFORT_MAX)
  .regex(REASONING_EFFORT_RE, "invalid reasoning effort charset");

const RuntimeReasoningOptionSchema = z.object({
  value: ReasoningEffortSchema,
  description: z.string().max(COMMUNITY_REASONING_DESCRIPTION_MAX).optional(),
});

const RuntimeReasoningModelSchema = z.object({
  id: z.string().min(1).max(100),
  displayName: z.string().min(1).max(COMMUNITY_REASONING_DESCRIPTION_MAX).optional().catch(undefined),
  supportedReasoningEfforts: z
    .array(z.unknown())
    .max(COMMUNITY_REASONING_OPTIONS_MAX)
    .transform((options) => {
      const seen = new Set<string>();
      return options.flatMap((candidate) => {
        const parsed = RuntimeReasoningOptionSchema.safeParse(candidate);
        if (!parsed.success) return [];
        const option = parsed.data;
        if (seen.has(option.value)) return [];
        seen.add(option.value);
        return [option];
      });
    }),
  defaultReasoningEffort: ReasoningEffortSchema.optional().catch(undefined),
}).transform((model) => {
  const { defaultReasoningEffort, ...rest } = model;
  return defaultReasoningEffort !== undefined
    && model.supportedReasoningEfforts.some((option) => option.value === defaultReasoningEffort)
    ? { ...rest, defaultReasoningEffort }
    : rest;
});

export const RuntimeReasoningCatalogSchema = z.object({
  catalogOrigin: z.enum(["native_report", "adapter_suggestions"]).optional().catch(undefined),
  updateMode: z.enum(["live_next_turn", "context_preserving_restart", "unsupported"]),
  defaultModelId: z.string().min(1).max(100).optional().catch(undefined),
  models: z
    .array(z.unknown())
    .transform((models) => {
      const seen = new Set<string>();
      const retained: z.infer<typeof RuntimeReasoningModelSchema>[] = [];
      for (const candidate of models) {
        const parsed = RuntimeReasoningModelSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const model = parsed.data;
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        retained.push(model);
        if (retained.length >= COMMUNITY_REASONING_MODELS_MAX) break;
      }
      return retained;
    }),
});

// Per-runtime health, reported by the daemon. `status` defaults to "healthy"
// so an older daemon that ships {id, version} still parses; `.catch("healthy")`
// additionally absorbs null / unknown-enum future values (e.g. "degraded") so
// a schema mismatch never poisons the whole ready frame. Fail-open is correct
// for a per-runtime signal — mistakenly rendering an unhealthy runtime as
// healthy is preferable to dropping every runtime a bad daemon sends.
export const CommunityMachineRuntimeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(COMMUNITY_RUNTIME_ID_MAX)
    .regex(RUNTIME_ID_RE, "invalid runtime id charset"),
  version: z.string().max(COMMUNITY_RUNTIME_VERSION_MAX).optional(),
  status: z.enum(["healthy", "unhealthy"]).catch("healthy").default("healthy"),
  lastError: z.string().max(128).optional(),
  lastErrorAt: z.string().optional(),
  reasoning: RuntimeReasoningCatalogSchema.optional().catch(undefined),
});
export type CommunityMachineRuntime = z.infer<typeof CommunityMachineRuntimeSchema>;

export const CommunityMachineRuntimeListSchema = z
  .array(CommunityMachineRuntimeSchema)
  .max(COMMUNITY_RUNTIME_LIST_MAX)
  .transform((list) => {
    const seen = new Set<string>();
    const out: z.infer<typeof CommunityMachineRuntimeSchema>[] = [];
    for (const r of list) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  });

export const RuntimeModelDiscoveryResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete"), catalog: RuntimeReasoningCatalogSchema.nullable() }),
  RuntimeModelDiscoveryErrorSchema,
]);

export const HostRuntimeModelsFrameSchema = RuntimeModelDiscoveryRequestSchema.extend({
  type: z.literal("runtime_models"),
  result: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("complete"), runtimeReport: CommunityMachineRuntimeListSchema }),
    RuntimeModelDiscoveryErrorSchema,
  ]),
});

const CommunityRunningAgentListSchema = z.array(z.string()).transform((list) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
});

export const CommunityMachineSummarySchema = z.strictObject({
  id: z.string(),
  hostname: z.string(),
  displayName: z.string(),
  platform: z.string(),
  arch: z.string(),
  osRelease: z.string(),
  daemonVersion: z.string(),
  lastSeenAt: z.string().nullable(),
  status: z.enum(["online", "offline"]),
  availableRuntimes: z.array(CommunityMachineRuntimeSchema.strict()),
  /**
   * Last runtime error reported by the daemon (optimistically cleared on
   * subsequent `agent:wake` forward). Optional so pre-error summaries
   * omit the field entirely — undefined == "no known error."
   */
  lastRuntimeError: z
    .strictObject({
      requested: z.string(),
      available: z.array(z.string()),
      at: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommunityMachineSummary = z.infer<typeof CommunityMachineSummarySchema>;

/**
 * `HostReady` message — the daemon's post-connect state dump. `runtimes`
 * (the legacy string-only list) is intentionally rejected here; daemons
 * must send `runtimeReport`. Old daemons are pushed off by the
 * `MIN_CLI_VERSION` gate on the next reconnect.
 */
export const HostReadyMessageSchema = z.object({
  type: z.literal("ready"),
  runtimeReport: CommunityMachineRuntimeListSchema,
  capabilities: z.array(z.string().min(1).max(64)).max(16).optional().default([]),
  runningAgents: CommunityRunningAgentListSchema.default([]),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  osRelease: z.string().optional(),
  daemonVersion: z.string().optional(),
  timeZone: z.string().min(1).max(128).optional(),
  providerQuotas: ProviderQuotaSnapshotListSchema.optional().default([]),
});
export type HostReadyMessage = z.infer<typeof HostReadyMessageSchema>;

/**
 * Retained for the /activate HTTP body only — the daemon includes an
 * optional runtime report in the initial activation request.
 */
export const CommunityDaemonReadySchema = z.object({
  runtimeReport: CommunityMachineRuntimeListSchema.optional(),
  runningAgents: CommunityRunningAgentListSchema.default([]),
  hostname: z.string().optional(),
  os: z.string().optional(),
  arch: z.string().optional(),
  osRelease: z.string().optional(),
  daemonVersion: z.string().optional(),
});
export type CommunityDaemonReady = z.infer<typeof CommunityDaemonReadySchema>;

/**
 * `session.error` frame — daemon → server. Currently used by the
 * agent router when a runtime isn't available on the host.
 */
export const SessionErrorFrameSchema = z.object({
  type: z.literal("session.error"),
  code: z.enum(["runtime_not_available"]),
  agentId: z.string().optional(),
  launchId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type SessionErrorFrame = z.infer<typeof SessionErrorFrameSchema>;

/**
 * `agent_activity` frame — daemon → server. Reports a bot's derived activity
 * state (see `AgentActivityState`/`deriveActivity` in
 * `src/daemon/src/manager/managerRuntime.ts`).
 */
export const AgentActivityMessageSchema = z.object({
  type: z.literal("agent_activity"),
  agentId: z.string(),
  state: z.enum(["idle", "starting", "running", "stopping"]),
  usageTimeZone: z.string().min(1).max(128).optional(),
  usageDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dailyUsage: z.array(DailyUsageSnapshotSchema).max(DAILY_TOKEN_USAGE_WINDOW_DAYS).optional(),
  quota: ProviderQuotaSnapshotSchema.optional(),
});
export type AgentActivityMessage = z.infer<typeof AgentActivityMessageSchema>;

/**
 * `agent_typing` / `agent_typing_stop` frames — daemon → server. Report
 * that a bot is (or is not) actively working on a specific channel (a DM is
 * a channel now). The daemon meters cadence (5s heartbeat while running;
 * one-shot stop on idle) so ws-do can fan out unconditionally without
 * traversing the 8s client-typing dedup gate.
 */
export const AgentTypingMessageSchema = z.object({
  type: z.literal("agent_typing"),
  agentId: z.string(),
  channelId: z.string().min(1),
});
export type AgentTypingMessage = z.infer<typeof AgentTypingMessageSchema>;

export const AgentTypingStopMessageSchema = z.object({
  type: z.literal("agent_typing_stop"),
  agentId: z.string(),
  channelId: z.string().min(1),
});
export type AgentTypingStopMessage = z.infer<typeof AgentTypingStopMessageSchema>;

/**
 * `agent_session` frame — daemon → server. Emitted per live agent once it is
 * really up and has a session (reborn-ready), carrying the `launchId` of the
 * launch that produced it. This is the completion signal the reset/nap
 * audit+awake re-home hangs on: the DO correlates `launchId` back to the
 * pending (launchId → trigger) map it recorded at dispatch, writes the audit +
 * awake stamp exactly once, then drops the map entry.
 */
export const AgentSessionMessageSchema = z.object({
  type: z.literal("agent_session"),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  launchId: z.string().min(1),
});
export type AgentSessionMessage = z.infer<typeof AgentSessionMessageSchema>;

/**
 * `agent_wake_ack` frame — daemon → server. Acknowledges a wake/reset/nap
 * command. `status: "error"` on the non-runtime failure branch of
 * `runRestartCommand` (enroll fail, spawn threw) — used by the reset/nap
 * re-home to evict the pending attribution map entry on a cold-start failure
 * (the twin branch, `runtime_not_available`, arrives as `session.error`).
 */
export const AgentWakeAckMessageSchema = z.object({
  type: z.literal("agent_wake_ack"),
  agentId: z.string().min(1),
  launchId: z.string().min(1),
  status: z.enum(["ok", "error"]),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});
export type AgentWakeAckMessage = z.infer<typeof AgentWakeAckMessageSchema>;

export const MachineHeartbeatAckMessageSchema = z.strictObject({
  type: z.literal("machine_heartbeat_ack"),
  nonce: z.string().min(1).max(128),
});
export type MachineHeartbeatAckMessage = z.infer<typeof MachineHeartbeatAckMessageSchema>;

export const DiagnosticCommandAckMessageSchema = z.strictObject({
  type: z.literal("diagnostics_ack"),
  reportId: DiagnosticReportIdSchema,
});
export type DiagnosticCommandAckMessage = z.infer<typeof DiagnosticCommandAckMessageSchema>;

export const CommunityPairTokenResponseSchema = z.object({
  tokenId: z.string(),
  expiresAt: z.string(),
});
export type CommunityPairTokenResponse = z.infer<typeof CommunityPairTokenResponseSchema>;

// ---------------------------------------------------------------------------
// Community daemon (Bearer machineKey) — activate + enroll-agent contracts
// Both request/response shapes are shared source-of-truth between the daemon
// (src/daemon/**) and the server (src/web/**). Keep in sync.
// ---------------------------------------------------------------------------

export const CommunityDaemonActivateRequestSchema = z.object({
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  expectedMachineId: z.string().min(1).optional(),
  osRelease: z.string().optional(),
  daemonVersion: z.string().optional(),
  runtimeReport: CommunityMachineRuntimeListSchema.optional(),
});
export type CommunityDaemonActivateRequest = z.infer<typeof CommunityDaemonActivateRequestSchema>;

export const CommunityDaemonActivateResponseSchema = z.object({
  credential: z.string(),
  machineId: z.string(),
  expiresAt: z.string().nullable(),
  sessionOutcome: z.literal("committed"),
});
export type CommunityDaemonActivateResponse = z.infer<typeof CommunityDaemonActivateResponseSchema>;

export const CommunityDaemonActivateErrorResponseSchema = z.object({
  error: z.string(),
  sessionOutcome: z.enum(["not_committed", "unknown"]),
});
export type CommunityDaemonActivateErrorResponse = z.infer<typeof CommunityDaemonActivateErrorResponseSchema>;

export const CommunityDaemonEnrollAgentRequestSchema = z.object({
  agentId: z.string().min(1).max(128),
});
export type CommunityDaemonEnrollAgentRequest = z.infer<typeof CommunityDaemonEnrollAgentRequestSchema>;

export const CommunityDaemonEnrollAgentResponseSchema = z.object({
  runnerKey: z.string(),
  expiresAt: z.string().nullable(),
});
export type CommunityDaemonEnrollAgentResponse = z.infer<typeof CommunityDaemonEnrollAgentResponseSchema>;

import {
  COMMUNITY_BOT_REQUEST_MAX_ITEMS,
  COMMUNITY_BOT_NAME_MIN,
  COMMUNITY_BOT_NAME_MAX,
  COMMUNITY_BOT_DESCRIPTION_MAX,
  COMMUNITY_BOT_IMAGE_URL_MAX,
} from "./constants";
import { validateCommunityName } from "./lib/community-name";

// A bot is a mentionable community member, so its name must satisfy the same
// `@Name#dddd` mention-grammar rules as a human display name (no `#`/`@`/line
// breaks). Reused as a `.refine` on both bot-name fields below.
const isMentionSafeName = (name: string): boolean => validateCommunityName(name).ok;
const MENTION_SAFE_NAME_MSG = "name cannot contain #, @, or line breaks";

// Accepts an https URL, the exact bot-avatar route shape
// (`/api/community/bots/{id}/avatar`), or
// the in-house `avatar:` serialized config produced by `serializeAvatarConfig`
// in the web avatar picker. This gates client-supplied input on the plain
// create/patch endpoints, so it must NOT accept an arbitrary leading-`/`
// path: that would let a bot owner point every viewer's browser at a
// protocol-relative URL (`//evil.com/...`) or an arbitrary same-origin path.
const BOT_AVATAR_ROUTE_PATTERN = /^\/api\/community\/bots\/[A-Za-z0-9_-]+\/avatar$/;
const BotImageUrlSchema = z
  .string()
  .max(COMMUNITY_BOT_IMAGE_URL_MAX)
  .refine(
    (v) =>
      v.startsWith("https://") ||
      v.startsWith("avatar:") ||
      BOT_AVATAR_ROUTE_PATTERN.test(v),
    {
      message: "image must be an https URL, the bot avatar route, or an avatar: config",
    },
  );

export const CommunityBotCreateRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(COMMUNITY_BOT_NAME_MIN)
    .max(COMMUNITY_BOT_NAME_MAX)
    .refine(isMentionSafeName, { message: MENTION_SAFE_NAME_MSG }),
  description: z.string().max(COMMUNITY_BOT_DESCRIPTION_MAX).optional(),
  machineId: z.string().min(1),
  runtime: z.string().min(1),
  image: BotImageUrlSchema.optional(),
  // Full launchable model id, or null for the runtime's default. `undefined`
  // ⇒ untouched (default), explicit `null` ⇒ default.
  model: z.string().trim().min(1).max(BOT_MODEL_NAME_MAX_LENGTH).nullable().optional(),
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
});
export type CommunityBotCreateRequest = z.infer<typeof CommunityBotCreateRequestSchema>;

export const CommunityBotPatchRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(COMMUNITY_BOT_NAME_MIN)
      .max(COMMUNITY_BOT_NAME_MAX)
      .refine(isMentionSafeName, { message: MENTION_SAFE_NAME_MSG })
      .optional(),
    description: z.string().max(COMMUNITY_BOT_DESCRIPTION_MAX).optional(),
    image: BotImageUrlSchema.nullable().optional(),
    // Full launchable model id, or null for the runtime's default. Explicit
    // `null` clears a set model; `undefined` leaves it untouched.
    model: z.string().trim().min(1).max(BOT_MODEL_NAME_MAX_LENGTH).nullable().optional(),
    runtime: z.string().trim().min(1).max(COMMUNITY_RUNTIME_ID_MAX).optional(),
    reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.image !== undefined ||
      v.runtime !== undefined ||
      "reasoningEffort" in v ||
      // `model` alone is a valid patch. An explicit `null` must count as
      // present — hence the `in` form, not a truthiness check.
      "model" in v,
    {
      message: "at least one field must be provided",
    }
  );
export type CommunityBotPatchRequest = z.infer<typeof CommunityBotPatchRequestSchema>;

export const CommunityBotAddToServerRequestSchema = z.object({
  botId: z.string().min(1),
});
export type CommunityBotAddToServerRequest = z.infer<
  typeof CommunityBotAddToServerRequestSchema
>;

export const CommunityServerOnboardRequestSchema = z.strictObject({
  bots: z.array(z.strictObject({
    id: z.string().min(1).max(128),
    wakePrompt: z.string()
      .max(AGENT_EVENT_PROMPT_MAX_LENGTH)
      .refine((value) => value.trim().length > 0, "wakePrompt is required"),
  }))
    .min(1)
    .max(COMMUNITY_BOT_REQUEST_MAX_ITEMS)
    .refine((bots) => new Set(bots.map((bot) => bot.id)).size === bots.length, "bot ids must be unique"),
  leadBotId: z.string().min(1).max(128),
  action: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("wake"),
      botId: z.string().min(1).max(128),
    }),
    z.strictObject({ type: z.literal("finalize") }),
  ]),
}).refine(
  ({ bots, leadBotId }) => bots.some((bot) => bot.id === leadBotId),
  { message: "leadBotId must reference an onboarded bot", path: ["leadBotId"] },
).refine(
  ({ bots, action }) => action.type !== "wake" || bots.some((bot) => bot.id === action.botId),
  { message: "wake botId must reference an onboarded bot", path: ["action", "botId"] },
);
export type CommunityServerOnboardRequest = z.infer<
  typeof CommunityServerOnboardRequestSchema
>;

// ---------------------------------------------------------------------------
// Community REST agent-door request/response validators. Mirror the lifted
// `@alook/shared/community-cli-contract`
// wire types verbatim (see `community-cli-contract.ts`). `agentId` is deliberately
// OMITTED from every request schema below — identity comes from the `crk_` bearer
// via `withAgentRunnerAuth`, never a client-supplied field (see plan §2/§7).
// ---------------------------------------------------------------------------

// `text` is relaxed to `default("")` so bots can send an attachment-only
// message. The top-level refinement below enforces "text OR attachments".
const CommunityAgentMessageContentSchema = z
  .object({ text: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).default("") })
  .catchall(z.unknown());

const CommunityAgentSeqSchema = z.number().int().min(0);
const CommunityAgentPositiveSeqSchema = z.number().int().min(1);

export const CommunityAgentCursorSchema = z.object({
  channel: z.string().min(1),
  seq: CommunityAgentPositiveSeqSchema,
});
export type CommunityAgentCursor = z.infer<typeof CommunityAgentCursorSchema>;

export const CommunityAgentSendRequestSchema = z
  .object({
    channel: z.string().min(1),
    content: CommunityAgentMessageContentSchema,
    attachments: z
      .array(z.string().min(1))
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .default([]),
    seenUpToSeq: CommunityAgentSeqSchema.optional(),
    replyToSeq: CommunityAgentPositiveSeqSchema.optional(),
    force: z.boolean().optional(),
    // Idempotency key — generated once per logical message, reused across
    // retries; server dedupes on (author, nonce). Bounded length so a client
    // can't stuff arbitrary data. Absent = no dedup (legacy behavior).
    nonce: z.string().min(1).max(128).optional(),
    // When the resolved target is a forum this message becomes the opener and
    // the server synchronously creates its child thread. A first reply is a
    // separate ordinary send to the returned thread ref; there is no combined
    // title/body field on the canonical message contract.
  })
  .refine(
    (d) => d.content.text.trim().length > 0 || d.attachments.length > 0,
    { message: "message must have text or attachments" }
  );
export type CommunityAgentSendRequest = z.infer<typeof CommunityAgentSendRequestSchema>;

// Response body for POST /api/community/channels/{id}/attachments. Bots see
// filename+contentType+size and nothing else — no url, no r2 key, no path.
export const CommunityAgentAttachmentUploadResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  hasThumbnail: z.boolean().optional(),
});
export type CommunityAgentAttachmentUploadResponse = z.infer<
  typeof CommunityAgentAttachmentUploadResponseSchema
>;

export const CommunityAgentAttachmentDownloadRequestSchema = z.object({
  id: z.string().min(1),
});
export type CommunityAgentAttachmentDownloadRequest = z.infer<
  typeof CommunityAgentAttachmentDownloadRequestSchema
>;

export const CommunityAgentUpdateProfileRequestSchema = z
  .object({
    bio: z.string().max(MAX_PROFILE_ABOUT_LENGTH).optional(),
    avatar: z
      .object({
        filename: z.string().min(1),
        contentType: z.enum(ALLOWED_ICON_MIME_TYPES),
        data: z.instanceof(Uint8Array)
          .refine((value) => value.byteLength > 0, "avatar must not be empty")
          .refine(
            (value) => value.byteLength <= MAX_SERVER_ICON_SIZE_BYTES,
            `avatar must be ≤ ${MAX_SERVER_ICON_SIZE_BYTES} bytes`,
          ),
      })
      .optional(),
  })
  .refine((value) => value.bio !== undefined || value.avatar !== undefined, {
    message: "bio or avatar is required",
  });
export type CommunityAgentUpdateProfileRequest = z.infer<
  typeof CommunityAgentUpdateProfileRequestSchema
>;

export const CommunityAgentInboxPullRequestSchema = z.object({
  max: z.number().int().min(1).max(200).optional(),
});
export type CommunityAgentInboxPullRequest = z.infer<typeof CommunityAgentInboxPullRequestSchema>;

export const CommunityAgentAckRequestSchema = z.object({
  cursors: z.array(CommunityAgentCursorSchema).min(1),
});
export type CommunityAgentAckRequest = z.infer<typeof CommunityAgentAckRequestSchema>;

export const CommunityAgentReadRequestSchema = z
  .object({
    channel: z.string().min(1),
    before: CommunityAgentSeqSchema.optional(),
    after: CommunityAgentSeqSchema.optional(),
    around: CommunityAgentSeqSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine(
    (v) => [v.before, v.after, v.around].filter((x) => x !== undefined).length <= 1,
    { message: "at most one of before/after/around may be supplied" }
  );
export type CommunityAgentReadRequest = z.infer<typeof CommunityAgentReadRequestSchema>;

export const CommunityAgentResolveRequestSchema = z.object({
  channel: z.string().min(1),
  seq: CommunityAgentSeqSchema,
});
export type CommunityAgentResolveRequest = z.infer<typeof CommunityAgentResolveRequestSchema>;

export const CommunityAgentListChannelsRequestSchema = z.object({
  server: z.string().min(1).optional(),
});
export type CommunityAgentListChannelsRequest = z.infer<
  typeof CommunityAgentListChannelsRequestSchema
>;

export const CommunityAgentListMembersRequestSchema = z.object({
  server: z.string().min(1),
  limit: z.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
});
export type CommunityAgentListMembersRequest = z.infer<
  typeof CommunityAgentListMembersRequestSchema
>;

export const CommunityAgentChannelMemberRequestSchema = z.object({
  channel: z.string().min(1),
  agentId: z.string().optional(),
});
export type CommunityAgentChannelMemberRequest = z.infer<
  typeof CommunityAgentChannelMemberRequestSchema
>;

export const CommunityAgentJoinServerRequestSchema = z.object({
  invite: z.string().min(1),
});
export type CommunityAgentJoinServerRequest = z.infer<
  typeof CommunityAgentJoinServerRequestSchema
>;

export const CommunityAgentNapRequestSchema = z.object({
  handoff: z.string().refine((value) => value.trim().length > 0, {
    message: "handoff must not be blank",
  }).optional(),
});
export type CommunityAgentNapRequest = z.infer<
  typeof CommunityAgentNapRequestSchema
>;

export const CommunityAgentMessagePropertyRequestSchema = z.object({
  channel: z.string().min(1),
  seq: CommunityAgentPositiveSeqSchema,
  property: z.unknown(),
});
export type CommunityAgentMessagePropertyRequest = z.infer<
  typeof CommunityAgentMessagePropertyRequestSchema
>;

// POST /api/community/friends/request — body `{ username: "name#0042" }`.
// Only the human `name#discriminator` handle is accepted (parsed + resolved
// server-side); a raw userId is intentionally NOT accepted so the agent surface
// mirrors the human handle format.
export const CommunityAgentFriendRequestSchema = z.object({
  username: z.string().min(1),
});
export type CommunityAgentFriendRequest = z.infer<
  typeof CommunityAgentFriendRequestSchema
>;

// Empty body retained for the shared list-friends request contract.
export const CommunityAgentListFriendsSchema = z.object({});
export type CommunityAgentListFriends = z.infer<
  typeof CommunityAgentListFriendsSchema
>;

//
// Shared between the daemon (producer), ws-do (persistence), and web
// (route reader). The `payload` column stores JSON matching one of these
// discriminated branches.
//
// - cli_invocation → the daemon's credential proxy handled an alook subcommand
// - tool_call      → the runtime invoked a tool. `name` is a canonical
//                    lowercase tag (`bash`, `read`, `edit`, `write`, `grep`,
//                    `glob`, `find`, `ls`, `notebook_edit`, `web_search`,
//                    `web_fetch`, `todo_write`, `mcp_*`, `collab_tool_call`,
//                    …) — case-collapsed on the daemon write side so a mixed
//                    stream of `Bash` and `bash` reads as one shape.
//                    Bash-family calls whose resolved command is
//                    `alook <sub>` are suppressed here (the credential proxy
//                    emits the authoritative `cli_invocation` for those);
//                    every other tool call lands here with an optional
//                    `target` — the file path, shell command, search
//                    pattern, url, or MCP tool name that the call acts on.
//                    Historical rows written before this convention keep
//                    whatever `name` they were persisted with; unknown keys
//                    (e.g. the pre-shipping `command` field from a local
//                    dev branch) are silently dropped by Zod's default
//                    strip-unknown behavior, so a legacy `{name, command}`
//                    row parses as `{name}` — rendered as name-only.
// - thinking       → excerpted thinking text, truncated at 4096 UTF-8 bytes

export const AuditLogCliInvocationPayloadSchema = z.object({
  subcommand: z.string().min(1),
  propertyType: z.enum(["emoji", "tag", "mark"]).optional(),
});
export const AuditLogToolCallPayloadSchema = z.object({
  name: z.string().min(1),
  /**
   * Short human-facing summary of what the tool acted on — file path for
   * file-target tools, first non-empty line of the shell command for
   * `bash`, `pattern` for search tools, `url` / `query` / MCP name for
   * fallthrough tools. Absent for tools that have no meaningful entity
   * (e.g. `todo_write`) or when the runtime emitted an input we couldn't
   * pick a field from. Capped at 240 UTF-16 code units to match the wire
   * budget; the daemon truncates to 200 code units + `…` before sending
   * so future producers have headroom.
   */
  target: z.string().max(240).optional(),
});
export const AuditLogThinkingPayloadSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  chars: z.number().int().nonnegative(),
});
export const AuditLogTextPayloadSchema = z.object({
  text: z.string().min(1).max(BOT_AUDIT_TEXT_MAX_BYTES).refine(
    (text) => new TextEncoder().encode(text).byteLength <= BOT_AUDIT_TEXT_MAX_BYTES,
    { message: "Text exceeds 1024 UTF-8 bytes" },
  ),
  truncated: z.boolean(),
  chars: z.number().int().nonnegative(),
});
export const AuditLogTurnInterruptPayloadSchema = z.object({
  status: z.literal("accepted"),
});
export type AuditLogTurnInterruptPayload = z.infer<typeof AuditLogTurnInterruptPayloadSchema>;
/**
 * `wake_trigger` — one row per wake we ATTEMPTED to deliver. Written from
 * `buildUnreadWakeCommand` right before the `HostCommand` is returned to the
 * caller — the delivery hop (`sendWakeToMachine`) hasn't run yet. That
 * ordering is deliberate: on retry (transient D1/network blip) a second
 * audit row is preferable to a silently-lost wake, so audit-before-delivery
 * is the safer trade-off. Callers reading the audit log should treat rows as
 * "we tried this" not "the daemon received this" — the daemon-facing
 * delivery is best-effort. The `messageId` is the trigger;
 * `channel`/`seq` are denormalized for click-to-jump so the owner UI can
 * render without a second D1 fetch. `senderHandle` is frozen at wake time
 * (renaming after the fact does NOT rewrite past rows).
 */
export const AuditLogWakeTriggerPayloadSchema = z.object({
  messageId: z.string().min(1),
  channel: z.string().min(1),
  seq: CommunityAgentPositiveSeqSchema,
  senderId: z.string().min(1),
  senderHandle: z.string().min(1),
  reason: z.enum(["unread", "mention"]),
});
export type AuditLogWakeTriggerPayload = z.infer<typeof AuditLogWakeTriggerPayloadSchema>;

/**
 * `session_reset` payload — a completed context reset. Owner-triggered single
 * and batch resets are written when the reborn agent's `agent_session` lands;
 * `idle_timeout` is emitted after the daemon commits its local six-hour reset
 * barrier. No `actorId`: owner reset is owner-only and automatic reset has no
 * human actor. (Rows written before this shape carried `{}` and parse to null,
 * which the lenient client parser tolerates.)
 */
export const AuditLogSessionResetPayloadSchema = z.object({
  trigger: z.enum(["single", "reset_all", "idle_timeout"]),
});
export type AuditLogSessionResetPayload = z.infer<typeof AuditLogSessionResetPayloadSchema>;

/**
 * `nap` payload — the agent reset ITS OWN session via `alook nap`. Twin of
 * `session_reset` but self-initiated, so `trigger` is always `"nap"` and there
 * is no actor. Written at the same completion landing.
 */
export const AuditLogNapPayloadSchema = z.object({
  trigger: z.literal("nap"),
});
export type AuditLogNapPayload = z.infer<typeof AuditLogNapPayloadSchema>;

/**
 * `model_changed` payload — the owner switched a bot's LLM model. `from`/`to`
 * are the full stored ids; `null` means the runtime's default. Written only
 * after the daemon confirmed delivery (see plan decision #7).
 */
export const AuditLogModelChangedPayloadSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type AuditLogModelChangedPayload = z.infer<typeof AuditLogModelChangedPayloadSchema>;

export const AuditLogProviderChangedPayloadSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type AuditLogProviderChangedPayload = z.infer<typeof AuditLogProviderChangedPayloadSchema>;

/**
 * `error` payload — a launch/runtime failure the owner should see. Emitted by
 * the daemon (never written server-side, unlike `model_changed`), so a bot
 * that goes silent has a visible reason instead of a black hole.
 *
 * - `scope`  — which stage failed. `handshake_timeout` is the bad-model case:
 *   the process spawned but never emitted its handshake within the deadline.
 * - `code`   — machine reason (`pre_handshake_exit`, `handshake_timeout`,
 *   `runtime_error`, `ENOENT`, `spawn_threw`, …). Stable enough to group on.
 * - `message`— human one-liner, already scrubbed of secrets by the daemon.
 * - `model`  — the model in effect at failure (`null` = runtime default), so
 *   the common "switched to a bad model" case names the culprit inline.
 */
export const AuditLogErrorPayloadSchema = z.object({
  scope: z.enum(["spawn", "runtime", "exit", "handshake_timeout", "model_switch", "reset"]),
  code: z.string().min(1).max(120),
  message: z.string().max(2048),
  model: z.string().nullable(),
});
export type AuditLogErrorPayload = z.infer<typeof AuditLogErrorPayloadSchema>;

export const BotAuditEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cli_invocation"), payload: AuditLogCliInvocationPayloadSchema }),
  z.object({ kind: z.literal("tool_call"), payload: AuditLogToolCallPayloadSchema }),
  z.object({ kind: z.literal("thinking"), payload: AuditLogThinkingPayloadSchema }),
  z.object({ kind: z.literal("text"), payload: AuditLogTextPayloadSchema }),
  z.object({ kind: z.literal("turn_interrupt"), payload: AuditLogTurnInterruptPayloadSchema }),
  z.object({ kind: z.literal("wake_trigger"), payload: AuditLogWakeTriggerPayloadSchema }),
  z.object({ kind: z.literal("session_reset"), payload: AuditLogSessionResetPayloadSchema }),
  z.object({ kind: z.literal("nap"), payload: AuditLogNapPayloadSchema }),
  z.object({ kind: z.literal("model_changed"), payload: AuditLogModelChangedPayloadSchema }),
  z.object({ kind: z.literal("provider_changed"), payload: AuditLogProviderChangedPayloadSchema }),
  z.object({ kind: z.literal("error"), payload: AuditLogErrorPayloadSchema }),
]);
export type BotAuditEvent = z.infer<typeof BotAuditEventSchema>;

export const BotAuditEventKindSchema = z.enum([
  "cli_invocation",
  "tool_call",
  "thinking",
  "text",
  "turn_interrupt",
  "wake_trigger",
  "session_reset",
  "nap",
  "model_changed",
  "provider_changed",
  "error",
]);
export type BotAuditEventKind = z.infer<typeof BotAuditEventKindSchema>;

/**
 * `bot_audit_event` frame — daemon → server. Ordinary telemetry gets a server
 * creation time. A reliable idle reset carries the durable local barrier time
 * so delayed delivery cannot make Web Awake younger than the actual reset.
 */
export const HostBotAuditEventFrameSchema = z.object({
  type: z.literal("bot_audit_event"),
  eventId: z.string().min(1).max(128).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  agentId: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  launchId: z.string().nullable().optional(),
  event: BotAuditEventSchema,
}).superRefine((frame, ctx) => {
  if (
    frame.event.kind === "session_reset" &&
    frame.event.payload.trigger === "idle_timeout" &&
    (!frame.eventId || !frame.occurredAt)
  ) {
    if (!frame.eventId) {
      ctx.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "eventId is required for idle_timeout session_reset",
      });
    }
    if (!frame.occurredAt) {
      ctx.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "occurredAt is required for idle_timeout session_reset",
      });
    }
  }
});
export type HostBotAuditEventFrame = z.infer<typeof HostBotAuditEventFrameSchema>;

export const BotAuditEventAckFrameSchema = z.strictObject({
  type: z.literal("bot_audit_event_ack"),
  eventId: z.string().min(1).max(128),
});
export type BotAuditEventAckFrame = z.infer<typeof BotAuditEventAckFrameSchema>;
