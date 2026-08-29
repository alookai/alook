import type { AdapterEvent } from "../../internal/adapter.js";
import type { QuotaLimit, QuotaWindowIdentity } from "../../contract.js";
import type { SettledUsageProjector } from "../../internal/token-usage.js";

function canonicalId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 64
    ? value
    : fallback;
}

function mappedPlanName(value: unknown): string | undefined {
  switch (value) {
    case "free": return "Free";
    case "plus": return "Plus";
    case "pro": return "Pro";
    case "team": return "Team";
    case "business": return "Business";
    case "enterprise": return "Enterprise";
    case "edu": return "Education";
    default: return undefined;
  }
}

function quotaWindow(minutes: unknown, slot: "primary" | "secondary"): QuotaWindowIdentity | null {
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes <= 0) return null;
  if (minutes === 1_440) return { kind: "calendar", period: "day", displayName: "Daily usage limit" };
  if (minutes === 10_080) return { kind: "calendar", period: "week", displayName: "Weekly usage limit" };
  if (minutes === 43_200) return { kind: "calendar", period: "month", displayName: "Monthly usage limit" };
  return {
    kind: "rolling",
    durationSeconds: minutes * 60,
    displayName: slot === "primary" && minutes === 300
      ? "5 hour usage limit"
      : `${minutes} minute usage limit`,
  };
}

function resetIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

export function mapCodexQuotaSnapshots(snapshots: any[], sourceEpoch: string): AdapterEvent {
  const limits: QuotaLimit[] = [];
  let planName: string | undefined;
  for (const snapshot of snapshots) {
    const limitId = canonicalId(snapshot?.limitId ?? snapshot?.limit_id, "codex");
    const spark = /spark/i.test(limitId) || /spark/i.test(String(snapshot?.limitName ?? snapshot?.limit_name ?? ""));
    const product = spark
      ? { kind: "reported" as const, id: "codex-spark", displayName: "Spark" }
      : { kind: "reported" as const, id: "codex", displayName: "Codex" };
    const model = spark
      ? { kind: "reported" as const, id: "gpt-5.3-codex-spark" }
      : { kind: "not_applicable" as const };
    planName ??= mappedPlanName(snapshot?.planType ?? snapshot?.plan_type);
    for (const slot of ["primary", "secondary"] as const) {
      const value = snapshot?.[slot];
      const window = quotaWindow(value?.windowDurationMins ?? value?.window_duration_mins, slot);
      const usedPercent = value?.usedPercent ?? value?.used_percent;
      if (!window || typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
      const resetsAt = resetIso(value?.resetsAt ?? value?.resets_at);
      limits.push({
        bucket: { limitId, product, model, window },
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  if (limits.length === 0) {
    return {
      kind: "telemetry",
      name: "rate_limits",
      source: "codex_account_rate_limits_updated",
      quota: { status: "error", sourceEpoch, code: "invalid_response", retryable: true },
    };
  }
  return {
    kind: "telemetry",
    name: "rate_limits",
    source: "codex_account_rate_limits_updated",
    quota: {
      status: "available",
      sourceEpoch,
      ...(planName ? { planName } : {}),
      freshForSeconds: 300,
      limits,
    },
  };
}

export function mapCodexSettledUsage(
  params: any,
  projector: SettledUsageProjector,
): AdapterEvent | null {
  const backendSessionId = params?.threadId ?? params?.thread_id;
  const providerRecordId = params?.responseId ?? params?.response_id;
  const usage = params?.usage;
  if (
    typeof backendSessionId !== "string"
    || typeof providerRecordId !== "string"
    || !usage
  ) return null;
  return projector.project({
    runtime: "codex",
    backendSessionId,
    providerRecordId,
    source: "codex_raw_response_completed",
    input: usage.inputTokens ?? usage.input_tokens,
    output: usage.outputTokens ?? usage.output_tokens,
    cacheRead: usage.cachedInputTokens ?? usage.cached_input_tokens,
    cacheWrite: usage.cacheWriteInputTokens ?? usage.cache_write_input_tokens,
    inputIncludesCache: true,
    outputIncludesReasoning: true,
  });
}
