import { describe, expect, it } from "vitest"
import {
  DailyUsageSnapshotSchema,
  ProviderQuotaObservationSchema,
} from "./provider-telemetry.js"

function quotaLimit() {
  return {
    bucket: {
      limitId: "primary",
      product: { kind: "reported" as const, id: "codex", displayName: "Codex" },
      model: { kind: "reported" as const, id: "gpt-5.3-codex-spark" },
      window: { kind: "rolling" as const, durationSeconds: 18_000, displayName: "5 hour usage limit" },
    },
    usedPercent: 42.5,
    resetsAt: "2026-08-29T01:00:00.000Z",
  }
}

describe("provider telemetry schemas", () => {
  it("accepts exact zero and unavailable usage without conflating them", () => {
    expect(DailyUsageSnapshotSchema.parse({
      botId: "bot_1",
      day: "2026-08-29",
      metrics: {
        input: 0,
        output: 0,
        cache: null,
      },
    })).toEqual(expect.objectContaining({
      metrics: {
        input: 0,
        output: 0,
        cache: null,
      },
    }))
  })

  it("rejects unsafe token values", () => {
    const base = {
      botId: "bot_1",
      day: "2026-08-29",
      metrics: {
        input: Number.MAX_SAFE_INTEGER + 1,
        output: null,
        cache: null,
      },
    }
    expect(DailyUsageSnapshotSchema.safeParse(base).success).toBe(false)
  })

  it("accepts the Spark two-window fixture as two distinct bucket identities", () => {
    const primary = quotaLimit()
    const weekly = {
      ...quotaLimit(),
      bucket: {
        ...quotaLimit().bucket,
        limitId: "secondary",
        window: { kind: "calendar" as const, period: "week" as const, displayName: "Weekly usage limit" },
      },
    }
    expect(ProviderQuotaObservationSchema.safeParse({
      status: "available",
      sourceEpoch: "A".repeat(22),
      freshForSeconds: 300,
      limits: [primary, weekly],
    }).success).toBe(true)
  })

  it("rejects duplicate identities, out-of-range percentages, and labels over 64 UTF-8 bytes", () => {
    const duplicate = quotaLimit()
    expect(ProviderQuotaObservationSchema.safeParse({
      status: "available",
      sourceEpoch: "A".repeat(22),
      freshForSeconds: 300,
      limits: [duplicate, { ...duplicate, usedPercent: 12 }],
    }).success).toBe(false)
    expect(ProviderQuotaObservationSchema.safeParse({
      status: "available",
      sourceEpoch: "A".repeat(22),
      freshForSeconds: 300,
      limits: [{ ...quotaLimit(), usedPercent: 101 }],
    }).success).toBe(false)
    expect(ProviderQuotaObservationSchema.safeParse({
      status: "available",
      sourceEpoch: "A".repeat(22),
      planName: "🙂".repeat(17),
      freshForSeconds: 300,
      limits: [quotaLimit()],
    }).success).toBe(false)
  })
})
