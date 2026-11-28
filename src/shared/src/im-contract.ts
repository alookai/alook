import { z } from "zod";

export const IM_CONNECTOR_CAPABILITY = "im-connector-v1";

export const BOT_IM_PROVIDERS = ["telegram", "feishu", "slack", "wechat"] as const;
export const BotImProviderSchema = z.enum(BOT_IM_PROVIDERS);
export type BotImProvider = z.infer<typeof BotImProviderSchema>;

export const BOT_DAEMON_IM_PROVIDERS = ["wechat"] as const;
export const BotDaemonImProviderSchema = z.enum(BOT_DAEMON_IM_PROVIDERS);
export type BotDaemonImProvider = z.infer<typeof BotDaemonImProviderSchema>;

export const BOT_IM_ACCESS_POLICIES = ["allowlist", "anyone"] as const;
export const BotImAccessPolicySchema = z.enum(BOT_IM_ACCESS_POLICIES);
export type BotImAccessPolicy = z.infer<typeof BotImAccessPolicySchema>;

export const BOT_IM_QR_STATUSES = [
  "idle",
  "pending",
  "scanned",
  "confirmed",
  "expired",
  "error",
] as const;
export const BotImQrStatusSchema = z.enum(BOT_IM_QR_STATUSES);
export type BotImQrStatus = z.infer<typeof BotImQrStatusSchema>;

export const BOT_IM_DAEMON_STATUSES = [
  "scan_required",
  "connected",
  "session_expired",
  "error",
] as const;
export const BotImDaemonStatusSchema = z.enum(BOT_IM_DAEMON_STATUSES);
export type BotImDaemonStatus = z.infer<typeof BotImDaemonStatusSchema>;

export const BOT_IM_STATUS_FRAME_STATUSES = [
  "pending",
  "scanned",
  "confirmed",
  "expired",
  "error",
  "session_expired",
  "connected",
  "scan_required",
] as const;
export const BotImStatusFrameStatusSchema = z.enum(BOT_IM_STATUS_FRAME_STATUSES);
export type BotImStatusFrameStatus = z.infer<typeof BotImStatusFrameStatusSchema>;

export const BOT_IM_MAX_ALLOWED_SENDERS = 200;
export const BOT_IM_SENDER_ID_MAX_LENGTH = 128;
export const BOT_IM_EXTERNAL_REF_MAX_LENGTH = 64;
export const BOT_IM_EXTERNAL_SEND_MAX_BYTES = 4096;

export const ImQrStartCommandSchema = z.strictObject({
  type: z.literal("im:qr_start"),
  requestId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  triggerId: z.string().min(1).max(128),
  provider: BotDaemonImProviderSchema,
});
export type ImQrStartCommand = z.infer<typeof ImQrStartCommandSchema>;

export const ImConfigSyncCommandSchema = z.strictObject({
  type: z.literal("im:config_sync"),
  botId: z.string().min(1).max(128),
  triggerId: z.string().min(1).max(128),
  provider: BotDaemonImProviderSchema,
  action: z.enum(["upsert", "delete"]),
  enabled: z.boolean().optional(),
  name: z.string().min(1).max(80).optional(),
  accessPolicy: BotImAccessPolicySchema.optional(),
  allowedSenders: z.array(z.string().min(1).max(BOT_IM_SENDER_ID_MAX_LENGTH)).max(BOT_IM_MAX_ALLOWED_SENDERS).optional(),
  instruction: z.string().max(500).optional(),
});
export type ImConfigSyncCommand = z.infer<typeof ImConfigSyncCommandSchema>;

export const ImCommandSchema = z.discriminatedUnion("type", [
  ImQrStartCommandSchema,
  ImConfigSyncCommandSchema,
]);
export type ImCommand = z.infer<typeof ImCommandSchema>;

export const ImStatusFrameSchema = z.strictObject({
  type: z.literal("im_status"),
  requestId: z.string().min(1).max(128).optional(),
  botId: z.string().min(1).max(128),
  triggerId: z.string().min(1).max(128),
  provider: BotDaemonImProviderSchema,
  status: BotImStatusFrameStatusSchema,
  sessionId: z.string().min(1).max(128).nullable().optional(),
  qrUrl: z.string().min(1).max(2048).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  botAccountLabel: z.string().max(128).nullable().optional(),
  error: z.string().max(512).nullable().optional(),
});
export type ImStatusFrame = z.infer<typeof ImStatusFrameSchema>;

export const ExternalSendRequestSchema = z.strictObject({
  externalRef: z.string().trim().min(1).max(BOT_IM_EXTERNAL_REF_MAX_LENGTH),
  text: z.string().trim().min(1).max(BOT_IM_EXTERNAL_SEND_MAX_BYTES),
});
export type ExternalSendRequest = z.infer<typeof ExternalSendRequestSchema>;

export const ExternalSendResponseSchema = z.strictObject({
  state: z.literal("sent"),
  externalRef: z.string().min(1),
  platform: BotImProviderSchema,
  messageId: z.string().nullable(),
  pii: z.strictObject({
    triggeredFilters: z.array(z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
    })),
  }).optional(),
});
export type ExternalSendResponse = z.infer<typeof ExternalSendResponseSchema>;

export const DaemonImTriggerConfigSchema = z.strictObject({
  triggerId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  provider: BotDaemonImProviderSchema,
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  accessPolicy: BotImAccessPolicySchema,
  allowedSenders: z.array(z.string().min(1).max(BOT_IM_SENDER_ID_MAX_LENGTH)).max(BOT_IM_MAX_ALLOWED_SENDERS),
  instruction: z.string().max(500),
});
export type DaemonImTriggerConfig = z.infer<typeof DaemonImTriggerConfigSchema>;

export const DaemonImDeliveryReportSchema = z.strictObject({
  triggerId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  direction: z.enum(["inbound", "outbound"]),
  status: z.enum(["dispatched", "blocked", "ignored", "failed"]),
  eventType: z.string().min(1).max(64),
  summary: z.string().min(1).max(240),
  senderId: z.string().max(128).nullable().optional(),
  senderLabel: z.string().max(128).nullable().optional(),
  chatLabel: z.string().max(128).nullable().optional(),
  externalDeliveryId: z.string().max(128).nullable().optional(),
  lastError: z.string().max(512).nullable().optional(),
  occurredAtMs: z.number().int().positive().optional(),
  recordAuditWake: z.boolean().optional(),
});
export type DaemonImDeliveryReport = z.infer<typeof DaemonImDeliveryReportSchema>;
