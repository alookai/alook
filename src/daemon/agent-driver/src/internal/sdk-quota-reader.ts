import type { ProviderQuotaObservation } from "../contract.js";
import { resolveOptionalPackage } from "./optional-package.js";
import { SdkWorkerLane } from "./sdk-worker-lane.js";
import { quotaSource, type QuotaReadOptions } from "./quota-reader.js";
import { sdkQuotaWorker, type SdkQuotaResult } from "./sdk-quota-worker.js";

export async function readSdkQuota(backend: "copilot" | "qoder", options: QuotaReadOptions = {}): Promise<ProviderQuotaObservation | null> {
  const installed = resolveOptionalPackage(backend === "copilot" ? "@github/copilot-sdk" : "@qoder-ai/qoder-agent-sdk");
  const error = (code: "unavailable" | "invalid_response" | "provider_error", retryable = false) => { const source = quotaSource(backend, "unavailable"); return source.finish(source.error(code, retryable)); };
  if (!installed) return error("unavailable");
  const lane = new SdkWorkerLane(sdkQuotaWorker, { modulePath: installed.entry, cwd: process.cwd(), config: { command: options.command }, probe: { includeModels: false } }, { ...(options.env ?? process.env), CI: "1" });
  try {
    const result = await lane.probe(30_000) as SdkQuotaResult;
    if (typeof result?.identity !== "string" || !result.quota) return error("invalid_response", true);
    const source = quotaSource(backend, result.identity);
    return source.finish({ ...result.quota, sourceEpoch: source.epoch });
  } catch { return error("provider_error", true); }
  finally { await lane.stop({ reason: "quota_complete", forceAfterMs: 100 }); }
}
