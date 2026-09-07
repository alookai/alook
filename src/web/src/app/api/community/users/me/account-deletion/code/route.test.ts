import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const sendDeletionCode = vi.fn()

vi.mock("@/lib/middleware/auth", () => ({
  withCookieHumanAuth: (handler: (...args: any[]) => Promise<Response>) =>
    (request: NextRequest) => handler(request, {
      env: { DB: {} },
      userId: "user-1",
      email: "owner@example.com",
    }),
}))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/account-deletion/challenge", () => ({
  sendDeletionCode: (...args: unknown[]) => sendDeletionCode(...args),
}))

import { POST } from "./route"

function request() {
  return new NextRequest("https://alook.ai/api/community/users/me/account-deletion/code", {
    method: "POST",
  })
}

describe("account deletion code route", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses only the authenticated identity and returns the locked success shape", async () => {
    sendDeletionCode.mockResolvedValue({ kind: "sent", expiresIn: 300, resendAfter: 60 })
    const response = await POST(request(), {} as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, expires_in: 300, resend_after: 60 })
    expect(sendDeletionCode).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      userId: "user-1",
      email: "owner@example.com",
    })
  })

  it("returns Retry-After for the reused limiter", async () => {
    sendDeletionCode.mockResolvedValue({ kind: "rate_limited", retryAfter: 47 })
    const response = await POST(request(), {} as never)

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("47")
    expect(await response.json()).toEqual({ error: "RATE_LIMITED" })
  })

  it("returns a retryable send failure", async () => {
    sendDeletionCode.mockResolvedValue({ kind: "send_failed" })
    const response = await POST(request(), {} as never)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "CODE_SEND_FAILED" })
  })
})
