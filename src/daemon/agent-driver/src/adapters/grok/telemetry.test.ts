import { describe, expect, it } from "vitest";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import { normalizeGrokBilling, projectGrokUsage } from "./telemetry.js";

const epoch = "abcdefghijklmnopqrstuv";

describe("Grok telemetry", () => {
  it("projects disjoint input/cache while keeping output inclusive of reasoning and deduplicates", () => {
    const projector = new SettledUsageProjector();
    const usage = {
      inputTokens: 120,
      outputTokens: 40,
      cachedReadTokens: 15,
      cacheCreationTokens: 5,
      reasoningTokens: 10,
    };
    expect(projectGrokUsage(projector, "session", "prompt", usage)).toEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "grok.acp",
      usage: { input: 100, output: 40, cache: 20 },
    });
    expect(projectGrokUsage(projector, "session", "prompt", usage)).toBeNull();
  });

  it("does not invent incomplete or malformed usage", () => {
    const projector = new SettledUsageProjector();
    expect(projectGrokUsage(projector, "session", "incomplete", {
      usageIsIncomplete: true,
      inputTokens: 10,
    })).toBeNull();
    expect(projectGrokUsage(projector, "session", "malformed", {
      inputTokens: 10,
      cachedReadTokens: 20,
      outputTokens: -1,
    })).toEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "grok.acp",
      usage: { input: null, output: null, cache: 20 },
    });
  });

  it("maps weekly billing and the official unified zero shape", () => {
    expect(normalizeGrokBilling({
      subscriptionTier: "SuperGrok",
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          creditUsagePercent: 12.5,
          start: "2026-09-01T00:00:00Z",
          end: "2026-09-08T00:00:00Z",
        },
      },
    }, epoch)).toEqual({
      status: "available",
      sourceEpoch: epoch,
      planName: "SuperGrok",
      freshForSeconds: 300,
      limits: [{
        bucket: {
          limitId: "grok-build",
          product: { kind: "reported", id: "grok", displayName: "Grok Build" },
          model: { kind: "not_applicable" },
          window: {
            kind: "provider_defined",
            id: "USAGE_PERIOD_TYPE_WEEKLY",
            durationSeconds: 604800,
            displayName: "Weekly limit",
          },
        },
        usedPercent: 12.5,
        resetsAt: "2026-09-08T00:00:00.000Z",
      }],
    });

    expect(normalizeGrokBilling({
      config: {
        isUnifiedBillingUser: true,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        prepaidBalance: { val: 0 },
      },
    }, epoch)).toMatchObject({
      status: "available",
      limits: [{ usedPercent: 0 }],
    });
  });

  it("returns schema-shaped errors instead of claiming quota for unusable billing", () => {
    expect(normalizeGrokBilling({}, epoch)).toEqual({
      status: "error",
      sourceEpoch: epoch,
      code: "invalid_response",
      retryable: true,
    });
  });

  it("uses legacy billing dates, duration, and plan-name fallbacks", () => {
    expect(normalizeGrokBilling({
      subscription_tier: "Legacy",
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          creditUsagePercent: 20,
          billingPeriodStart: "2026-09-01T00:00:00Z",
          billingPeriodEnd: "2026-10-01T00:00:00Z",
        },
      },
    }, epoch)).toMatchObject({
      status: "available",
      planName: "Legacy",
      limits: [{
        bucket: { window: { durationSeconds: 2_592_000 } },
        resetsAt: "2026-10-01T00:00:00.000Z",
      }],
    });

    expect(normalizeGrokBilling({
      config: {
        currentPeriod: { creditUsagePercent: 30 },
        billingPeriodStart: "2026-09-01T00:00:00Z",
        billingPeriodEnd: "2026-09-11T00:00:00Z",
      },
    }, epoch)).toMatchObject({
      status: "available",
      limits: [{ bucket: { window: { durationSeconds: 864_000 } } }],
    });
  });
});
