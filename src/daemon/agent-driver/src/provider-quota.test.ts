import { describe, expect, it, vi } from "vitest";
import { readBuiltinProviderQuota } from "./provider-quota.js";

describe("readBuiltinProviderQuota", () => {
  it("maps Claude OAuth usage without exposing credentials in the observation", async () => {
    const fetchUsage = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-secret-token")
      return Response.json({
        five_hour: { utilization: 82, resets_at: "2026-08-29T05:00:00Z" },
        seven_day: { utilization: 41, resets_at: "2026-09-01T00:00:00Z" },
        seven_day_sonnet: { utilization: 12, resets_at: "2026-09-01T00:00:00Z" },
      })
    })
    const result = await readBuiltinProviderQuota("claude", {
      platform: "linux",
      env: {},
      readCredentialsFile: async () => JSON.stringify({
        claudeAiOauth: { accessToken: "local-secret-token", subscriptionType: "max" },
      }),
      fetchUsage: fetchUsage as typeof fetch,
    })
    expect(result).toMatchObject({
      status: "available",
      planName: "Max",
      freshForSeconds: 300,
      limits: [
        { bucket: { limitId: "five_hour", window: { durationSeconds: 18_000 } }, usedPercent: 82 },
        { bucket: { limitId: "seven_day", window: { durationSeconds: 604_800 } }, usedPercent: 41 },
        { bucket: { limitId: "seven_day_sonnet", model: { id: "claude-sonnet" } }, usedPercent: 12 },
      ],
    })
    expect(result?.sourceEpoch).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(JSON.stringify(result)).not.toContain("local-secret-token")
  })

  it("returns unsupported for custom Claude providers and non-quota backends", async () => {
    const readCredentialsFile = vi.fn(async () => "")
    await expect(readBuiltinProviderQuota("claude", {
      platform: "linux",
      env: { ANTHROPIC_API_KEY: "custom" },
      readCredentialsFile,
    })).resolves.toBeNull()
    await expect(readBuiltinProviderQuota("cursor")).resolves.toBeNull()
    expect(readCredentialsFile).not.toHaveBeenCalled()
  })

  it("changes the opaque source epoch when the local OAuth source changes", async () => {
    let token = "first-token"
    const options = {
      platform: "linux" as const,
      env: {},
      readCredentialsFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      fetchUsage: (async () => Response.json({
        five_hour: { utilization: 1, resets_at: "2026-08-29T05:00:00Z" },
      })) as typeof fetch,
    }
    const first = await readBuiltinProviderQuota("claude", options)
    token = "second-token"
    const second = await readBuiltinProviderQuota("claude", options)
    expect(first?.sourceEpoch).not.toBe(second?.sourceEpoch)
  })
})
