import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  env: { RESEND_API_KEY: "test-key" } as Env,
  checkRateLimit: vi.fn(),
  subscribeResendNewsletter: vi.fn(),
}))

vi.mock("@/lib/middleware/auth", () => ({
  optionalAuthPolicy: {
    resolve: async () => ({ context: { env: mocks.env, userId: undefined } }),
  },
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
}))
vi.mock("@/lib/resend-contacts", () => ({
  subscribeResendNewsletter: (...args: unknown[]) => mocks.subscribeResendNewsletter(...args),
}))

import { POST } from "./route"

function makeRequest(
  body: unknown,
  origin: string | null = "https://alook.ai",
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  }
  if (origin !== null) headers.Origin = origin
  return new NextRequest("https://alook.ai/api/newsletter/subscribe", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSec: 0 })
  mocks.subscribeResendNewsletter.mockResolvedValue("subscribed")
})

describe("POST /api/newsletter/subscribe", () => {
  it("subscribes a normalized email and sets no-store headers", async () => {
    const response = await POST(makeRequest(
      { email: "  Reader@Example.COM ", website: "" },
      "https://alook.ai",
      { "cf-connecting-ip": "203.0.113.10" },
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0")
    expect(await response.json()).toEqual({ ok: true, status: "subscribed" })
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(mocks.env, "newsletter:subscribe", "203.0.113.10")
    expect(mocks.subscribeResendNewsletter).toHaveBeenCalledWith(mocks.env, "reader@example.com")
  })

  it.each([
    ["missing origin", null],
    ["cross-origin", "https://evil.example"],
    ["non-http origin", "ftp://alook.ai"],
    ["malformed origin", "not-a-url"],
  ] as const)("rejects %s with 403", async (_label, origin) => {
    const response = await POST(makeRequest({ email: "reader@example.com" }, origin))
    expect(response.status).toBe(403)
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0")
    expect(mocks.subscribeResendNewsletter).not.toHaveBeenCalled()
  })

  it.each([
    ["malformed JSON", "{"],
    ["null body", null],
    ["missing email", {}],
    ["blank email", { email: "   " }],
    ["invalid email", { email: "not-an-email" }],
    ["oversized email", { email: `${"a".repeat(250)}@example.com` }],
  ] as const)("rejects %s with 400", async (_label, body) => {
    const response = await POST(makeRequest(body))
    expect(response.status).toBe(400)
    expect(mocks.subscribeResendNewsletter).not.toHaveBeenCalled()
  })

  it("silently absorbs honeypot submissions without calling Resend or rate limit", async () => {
    const response = await POST(makeRequest({ email: "bot@example.com", website: "https://spam.test" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: "subscribed" })
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.subscribeResendNewsletter).not.toHaveBeenCalled()
  })

  it("returns 429 with Retry-After when rate-limited", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 120 })
    const response = await POST(makeRequest({ email: "reader@example.com" }))
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("120")
    expect(mocks.subscribeResendNewsletter).not.toHaveBeenCalled()
  })

  it("returns 503 when Resend is unconfigured and 502 on upstream failure", async () => {
    mocks.subscribeResendNewsletter.mockResolvedValueOnce("unavailable")
    const unavailable = await POST(makeRequest({ email: "reader@example.com" }))
    expect(unavailable.status).toBe(503)

    mocks.subscribeResendNewsletter.mockResolvedValueOnce("failed")
    const failed = await POST(makeRequest({ email: "reader@example.com" }))
    expect(failed.status).toBe(502)
  })
})
