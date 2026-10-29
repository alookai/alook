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

export const RUNTIME_MODEL_CATALOG_FINGERPRINT_HEADER = "x-model-catalog-fingerprint";

export async function fingerprintRuntimeModelCatalog(catalog: RuntimeReasoningCatalog | null): Promise<string> {
  const canonical = JSON.stringify(catalog, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
    : value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
