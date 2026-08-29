import { z } from "zod";

const safeToken = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedText = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).length <= 64,
  { message: "must be at most 64 UTF-8 bytes" },
);

export const DailyUsageMetricSchema = safeToken.nullable();
export type DailyUsageMetric = z.infer<typeof DailyUsageMetricSchema>;

export const DailyUsageSnapshotSchema = z.object({
  botId: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metrics: z.object({
    input: DailyUsageMetricSchema,
    output: DailyUsageMetricSchema,
    cache: DailyUsageMetricSchema,
  }).strict(),
}).strict();
export type DailyUsageSnapshot = z.infer<typeof DailyUsageSnapshotSchema>;

export const QuotaProductIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reported"), id: boundedText, displayName: boundedText }).strict(),
  z.object({ kind: z.literal("unknown"), displayName: boundedText }).strict(),
]);
export type QuotaProductIdentity = z.infer<typeof QuotaProductIdentitySchema>;

export const QuotaModelIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reported"), id: boundedText }).strict(),
  z.object({ kind: z.literal("not_applicable") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
export type QuotaModelIdentity = z.infer<typeof QuotaModelIdentitySchema>;

export const QuotaWindowIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rolling"),
    durationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    displayName: boundedText,
  }).strict(),
  z.object({
    kind: z.literal("calendar"),
    period: z.enum(["day", "week", "month"]),
    displayName: boundedText,
  }).strict(),
  z.object({
    kind: z.literal("provider_defined"),
    id: boundedText,
    durationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    displayName: boundedText,
  }).strict(),
]);
export type QuotaWindowIdentity = z.infer<typeof QuotaWindowIdentitySchema>;

export const QuotaLimitSchema = z.object({
  bucket: z.object({
    limitId: boundedText,
    product: QuotaProductIdentitySchema,
    model: QuotaModelIdentitySchema,
    window: QuotaWindowIdentitySchema,
  }).strict(),
  usedPercent: z.number().finite().min(0).max(100),
  resetsAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type QuotaLimit = z.infer<typeof QuotaLimitSchema>;

function quotaIdentity(limit: QuotaLimit): string {
  const { product, model, window, limitId } = limit.bucket;
  const productKey = product.kind === "reported" ? `reported:${product.id}` : "unknown";
  const modelKey = model.kind === "reported" ? `reported:${model.id}` : model.kind;
  const windowKey = window.kind === "rolling"
    ? `rolling:${window.durationSeconds}`
    : window.kind === "calendar"
      ? `calendar:${window.period}`
      : `provider_defined:${window.id}:${window.durationSeconds === undefined ? "absent" : window.durationSeconds}`;
  return `${productKey}\u0000${modelKey}\u0000${windowKey}\u0000${limitId}`;
}

const AvailableQuotaObservationSchema = z.object({
  status: z.literal("available"),
  sourceEpoch: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  planName: boundedText.optional(),
  freshForSeconds: z.number().int().positive().max(86_400),
  limits: z.array(QuotaLimitSchema).min(1).max(8),
}).strict().superRefine((value, ctx) => {
  const identities = new Set<string>();
  for (const [index, limit] of value.limits.entries()) {
    const identity = quotaIdentity(limit);
    if (identities.has(identity)) {
      ctx.addIssue({ code: "custom", message: "duplicate quota bucket identity", path: ["limits", index] });
    }
    identities.add(identity);
  }
});

export const ProviderQuotaObservationSchema = z.union([
  AvailableQuotaObservationSchema,
  z.object({
    status: z.literal("error"),
    sourceEpoch: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    code: z.enum(["unavailable", "unauthorized", "network", "provider_error", "invalid_response"]),
    retryable: z.boolean(),
  }).strict(),
]);
export type ProviderQuotaObservation = z.infer<typeof ProviderQuotaObservationSchema>;

export const ProviderQuotaSnapshotSchema = z.object({
  agentBackendId: z.enum(["claude", "codex"]),
  observation: ProviderQuotaObservationSchema,
}).strict();
export type ProviderQuotaSnapshot = z.infer<typeof ProviderQuotaSnapshotSchema>;
