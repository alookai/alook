import { z } from "zod";
import type { RuntimeReasoningCatalog } from "./runtime-config";

export const RUNTIME_MODEL_DISCOVERY_CAPABILITY = "runtime-model-discovery-v1";

export const RuntimeModelDiscoveryRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(64),
});
export type RuntimeModelDiscoveryRequest = z.infer<typeof RuntimeModelDiscoveryRequestSchema>;

export const RuntimeModelDiscoveryCommandSchema = RuntimeModelDiscoveryRequestSchema.extend({
  type: z.literal("runtime:discover_models"),
});
export type RuntimeModelDiscoveryCommand = z.infer<typeof RuntimeModelDiscoveryCommandSchema>;

export const RuntimeModelDiscoveryErrorSchema = z.strictObject({
  status: z.literal("error"),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(256),
});
export type RuntimeModelDiscoveryError = z.infer<typeof RuntimeModelDiscoveryErrorSchema>;
export type RuntimeModelDiscoveryResult =
  | { status: "complete"; catalog: RuntimeReasoningCatalog | null }
  | RuntimeModelDiscoveryError;
