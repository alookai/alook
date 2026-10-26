import { z } from "zod";

export const PII_CAPABILITY = "pii-v1";
export const PII_MAX_PLUGINS = 32;
export const PII_SOURCE_MAX_BYTES = 16 * 1024;
export const PII_TEXT_MAX_BYTES = 1024;
export const PII_REQUEST_MAX_BYTES = 8 * 1024;
export const PiiPreviewTextSchema = z.string().max(PII_TEXT_MAX_BYTES)
  .refine(text => new TextEncoder().encode(text).byteLength <= PII_TEXT_MAX_BYTES)
  .refine(text => text.trim().length > 0);
export const PiiPluginSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(256),
  enabled: z.boolean(),
});
export const PiiSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  plugins: z.array(PiiPluginSchema).max(PII_MAX_PLUGINS),
});
const pluginId = z.string().min(1).max(128);
const expectedRevision = z.number().int().nonnegative();
export const PiiOperationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("setEnabled"), pluginId, enabled: z.boolean(), expectedRevision }),
  z.strictObject({ action: z.literal("remove"), pluginId, expectedRevision }),
  z.strictObject({ action: z.literal("preview"), text: PiiPreviewTextSchema, expectedRevision }),
]);
export const PiiRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  operation: PiiOperationSchema,
});
export const PiiCommandSchema = PiiRequestSchema.extend({
  type: z.literal("pii:manage"),
  botId: z.string().min(1).max(128),
});
export const PiiErrorCodeSchema = z.enum([
  "PII_CONFLICT", "PII_UNAVAILABLE", "PII_PLUGIN_NOT_FOUND", "PII_BOT_NOT_FOUND",
  "PII_PLUGIN_FAILED", "PII_PLUGIN_TIMEOUT", "PII_INVALID_RESULT", "PII_OUTPUT_TOO_LARGE",
  "PII_INVALID_SOURCE", "PII_CONFIG_UNAVAILABLE", "PII_SOURCE_TOO_LARGE", "PII_INVALID_REQUEST",
]);
export const PiiResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete"), snapshot: PiiSnapshotSchema, output: PiiPreviewTextSchema.optional(), triggeredFilters: z.array(PiiPluginSchema.pick({ id: true, name: true })).max(PII_MAX_PLUGINS).optional() }),
  z.strictObject({
    status: z.literal("error"),
    code: PiiErrorCodeSchema,
    pluginId: pluginId.optional(),
    snapshot: PiiSnapshotSchema.optional(),
  }),
]);
export const PiiResultFrameSchema = z.strictObject({
  type: z.literal("pii_result"),
  botId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  result: PiiResultSchema,
});
export const PiiLocalRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("add"),
    name: PiiPluginSchema.shape.name,
    description: PiiPluginSchema.shape.description,
    source: z.string().min(1).max(PII_SOURCE_MAX_BYTES),
  }),
]);
export type PiiPlugin = z.infer<typeof PiiPluginSchema>;
export type PiiSnapshot = z.infer<typeof PiiSnapshotSchema>;
export type PiiOperation = z.infer<typeof PiiOperationSchema>;
export type PiiRequest = z.infer<typeof PiiRequestSchema>;
export type PiiCommand = z.infer<typeof PiiCommandSchema>;
export type PiiResult = z.infer<typeof PiiResultSchema>;
export type PiiResultFrame = z.infer<typeof PiiResultFrameSchema>;
export type PiiLocalRequest = z.infer<typeof PiiLocalRequestSchema>;
