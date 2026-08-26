import { describe, expect, it, vi } from "vitest"
import { verifyLinkPreviewThumbnailLifecycle } from "./preflight-link-preview-thumbnails"

const ACCOUNT = "0123456789abcdef0123456789abcdef"
const BUCKET = "alook-community-media"
const TOKEN = "CF_PRIVATE_PREFLIGHT_TOKEN"
const URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/lifecycle`

function lifecycleRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "delete-link-preview-thumbnails-after-seven-days",
    enabled: true,
    conditions: { prefix: "link-preview-thumbnails/v1/" },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: 604_800 } },
    ...overrides,
  }
}

describe("link-preview thumbnail R2 lifecycle preflight", () => {
  it("passes one exact seven-day prefix rule without mutating Cloudflare", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      success: true,
      result: { rules: [lifecycleRule(), { enabled: true, conditions: { prefix: "other/" } }] },
    }))

    await expect(verifyLinkPreviewThumbnailLifecycle({
      accountId: ACCOUNT,
      bucketName: BUCKET,
      apiToken: TOKEN,
      fetchImpl,
    })).resolves.toEqual({ ok: true, sevenDayLifecycle: true })
    expect(fetchImpl).toHaveBeenCalledWith(URL, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  })

  it.each([
    ["missing", []],
    ["disabled", [lifecycleRule({ enabled: false })]],
    ["wrong prefix", [lifecycleRule({ conditions: { prefix: "link-preview-thumbnails/" } })]],
    ["wrong age", [lifecycleRule({ deleteObjectsTransition: { condition: { type: "Age", maxAge: 604_801 } } })]],
    ["duplicate", [lifecycleRule(), lifecycleRule()]],
  ])("fails closed when the required lifecycle is %s", async (_label, rules) => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ success: true, result: { rules } }))
    await expect(verifyLinkPreviewThumbnailLifecycle({
      accountId: ACCOUNT,
      bucketName: BUCKET,
      apiToken: TOKEN,
      fetchImpl,
    })).resolves.toEqual({ ok: false, sevenDayLifecycle: false })
  })

  it("rejects unsafe inputs and transport failures without leaking credentials", async () => {
    const fetchImpl = vi.fn()
    await expect(verifyLinkPreviewThumbnailLifecycle({
      accountId: "../account",
      bucketName: BUCKET,
      apiToken: TOKEN,
      fetchImpl,
    })).resolves.toMatchObject({ ok: false })
    expect(fetchImpl).not.toHaveBeenCalled()

    const logs: string[] = []
    await expect(verifyLinkPreviewThumbnailLifecycle({
      accountId: ACCOUNT,
      bucketName: BUCKET,
      apiToken: TOKEN,
      fetchImpl: vi.fn().mockRejectedValue(new Error(TOKEN)),
      log: (message) => logs.push(message),
    })).resolves.toMatchObject({ ok: false })
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })
})
