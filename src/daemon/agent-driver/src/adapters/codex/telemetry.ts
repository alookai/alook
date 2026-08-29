import type { AdapterEvent } from "../../internal/adapter.js";
import type { QuotaLimit, QuotaWindowIdentity, TokenMetricDelta } from "../../contract.js";

function metric(value: unknown): TokenMetricDelta {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nonCachedInput(input: unknown, cached: unknown): TokenMetricDelta {
  if (
    typeof input !== "number"
    || !Number.isSafeInteger(input)
    || input < 0
    || typeof cached !== "number"
    || !Number.isSafeInteger(cached)
    || cached < 0
    || cached > input
  ) return null;
  return input - cached;
}

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

export function mapCodexTelemetry(method: string, params: any, sourceEpoch: string): AdapterEvent[] {
  if (method === "thread/tokenUsage/updated") {
    const u = params?.tokenUsage?.last ?? params?.token_usage?.last;
    if (!u) return [];
    const input = u.inputTokens ?? u.input_tokens;
    const cached = u.cachedInputTokens ?? u.cached_input_tokens;
    return [{
      kind: "telemetry",
      name: "token_usage",
      source: "codex_thread_token_usage_updated",
      usage: {
        input: nonCachedInput(input, cached),
        output: metric(u.outputTokens ?? u.output_tokens),
        cache: metric(cached),
      },
    }];
  }
  if (method === "account/rateLimits/updated") {
    return [mapCodexQuotaSnapshots([params?.rateLimits ?? params ?? {}], sourceEpoch)];
  }
  return [];
}
