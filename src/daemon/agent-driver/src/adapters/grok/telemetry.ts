import type { AdapterEvent } from "../../internal/adapter.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import type { ProviderQuotaObservation } from "../../contract.js";
import { asRecord } from "../../internal/utils.js";

const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function amount(value: unknown): number | undefined {
  const row = asRecord(value);
  return number(row?.val ?? value);
}

export function projectGrokUsage(
  projector: SettledUsageProjector,
  sessionId: string,
  promptId: string,
  value: unknown,
): AdapterEvent | null {
  const usage = asRecord(value);
  if (!usage || usage.usageIsIncomplete === true) return null;
  return projector.project({
    runtime: "grok",
    backendSessionId: sessionId,
    providerRecordId: promptId,
    source: "grok.acp",
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens,
    cacheRead: usage.cachedReadTokens,
    cacheWrite: usage.cacheCreationTokens,
    inputIncludesCache: true,
    outputIncludesReasoning: true,
  });
}

function invalidQuota(sourceEpoch: string): ProviderQuotaObservation {
  return { status: "error", sourceEpoch, code: "invalid_response", retryable: true };
}

export function normalizeGrokBilling(value: unknown, sourceEpoch: string): ProviderQuotaObservation {
  const billing = asRecord(value);
  const config = asRecord(billing?.config);
  if (!billing || !config) return invalidQuota(sourceEpoch);
  const history = Array.isArray(config.history) ? config.history : [];
  const period = asRecord(config.currentPeriod) ?? asRecord(history.at(-1)) ?? config;
  let usedPercent = number(period.creditUsagePercent) ?? number(config.creditUsagePercent);
  if (usedPercent === undefined) {
    const limit = amount(period.monthlyLimit ?? config.monthlyLimit);
    const used = amount(period.totalUsed ?? period.includedUsed ?? period.used ?? config.totalUsed ?? config.used);
    if (limit && used !== undefined) usedPercent = (used / limit) * 100;
  }
  if (
    usedPercent === undefined
    && config.isUnifiedBillingUser === true
    && asRecord(config.currentPeriod)?.type === "USAGE_PERIOD_TYPE_WEEKLY"
    && amount(config.onDemandCap) === 0
    && amount(config.onDemandUsed) === 0
    && amount(config.prepaidBalance) === 0
  ) usedPercent = 0;
  if (usedPercent === undefined) return invalidQuota(sourceEpoch);

  const start = typeof period.start === "string"
    ? period.start
    : typeof period.billingPeriodStart === "string"
      ? period.billingPeriodStart
      : typeof config.billingPeriodStart === "string"
        ? config.billingPeriodStart
        : undefined;
  const end = typeof period.end === "string"
    ? period.end
    : typeof period.billingPeriodEnd === "string"
      ? period.billingPeriodEnd
      : typeof config.billingPeriodEnd === "string"
        ? config.billingPeriodEnd
        : undefined;
  const startMs = start ? Date.parse(start) : Number.NaN;
  const endMs = end ? Date.parse(end) : Number.NaN;
  const durationSeconds = period.type === "USAGE_PERIOD_TYPE_WEEKLY"
    ? SEVEN_DAY_SECONDS
    : Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 1_000)
      : undefined;
  const resetsAt = Number.isFinite(endMs) ? new Date(endMs).toISOString() : undefined;
  const periodId = typeof period.type === "string" && period.type.trim() ? period.type : "grok-build";
  const planName = typeof billing.subscriptionTier === "string" && billing.subscriptionTier.trim()
    ? billing.subscriptionTier
    : typeof billing.subscription_tier === "string" && billing.subscription_tier.trim()
      ? billing.subscription_tier
      : undefined;
  return {
    status: "available",
    sourceEpoch,
    ...(planName ? { planName } : {}),
    freshForSeconds: 300,
    limits: [{
      bucket: {
        limitId: "grok-build",
        product: { kind: "reported", id: "grok", displayName: "Grok Build" },
        model: { kind: "not_applicable" },
        window: {
          kind: "provider_defined",
          id: periodId,
          ...(durationSeconds ? { durationSeconds } : {}),
          displayName: period.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "Weekly limit" : "Grok Build limit",
        },
      },
      usedPercent: Math.min(100, usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
    }],
  };
}
