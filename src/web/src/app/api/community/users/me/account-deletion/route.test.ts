import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const verifyDeletionCode = vi.fn()
const executeAccountDeletion = vi.fn()
const restoreVerifiedDeletionCode = vi.fn()
const getPrimaryDb = vi.fn()
const signOut = vi.fn()

vi.mock("@/lib/middleware/auth", () => ({
  withCookieHumanAuth: (handler: (...args: any[]) => Promise<Response>) =>
    (request: NextRequest) => handler(request, {
      env: { DB: {} },
      executionContext: { waitUntil: vi.fn() },
      userId: "user-1",
      email: "owner@example.com",
    }),
}))
vi.mock("@/lib/db", () => ({ getPrimaryDb: (...args: unknown[]) => getPrimaryDb(...args) }))
vi.mock("@/lib/auth", () => ({ createAuth: () => ({ api: { signOut } }) }))
vi.mock("@/lib/account-deletion/challenge", () => ({
  verifyDeletionCode: (...args: unknown[]) => verifyDeletionCode(...args),
  restoreVerifiedDeletionCode: (...args: unknown[]) => restoreVerifiedDeletionCode(...args),
}))
vi.mock("@/lib/account-deletion/execution", () => ({
  executeAccountDeletion: (...args: unknown[]) => executeAccountDeletion(...args),
}))

import { POST } from "./route"

const challenge = { id: "challenge", identifier: "identifier", value: "123456:0" }

function request(body: unknown) {
  return new NextRequest("https://alook.ai/api/community/users/me/account-deletion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("account deletion submit route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPrimaryDb.mockReturnValue({
      query: {
        user: {
          findFirst: vi.fn().mockImplementation(async ({ where }) => {
            where({ id: "user-1" }, { eq: (left: unknown, right: unknown) => left === right })
            return { id: "user-1" }
          }),
        },
      },
    })
    verifyDeletionCode.mockResolvedValue({ kind: "verified", challenge })
    executeAccountDeletion.mockResolvedValue({ kind: "deleted" })
    restoreVerifiedDeletionCode.mockResolvedValue(undefined)
    const headers = new Headers()
    headers.append("Set-Cookie", "better-auth.session_token=; Max-Age=0; Path=/")
    signOut.mockResolvedValue({ headers })
  })

  it("rejects everything except strict six-digit JSON without consuming a challenge", async () => {
    for (const body of [{ otp: "12345" }, { otp: "123456", extra: true }, { otp: 123456 }]) {
      const response = await POST(request(body), {} as never)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "INVALID_OTP" })
    }
    expect(verifyDeletionCode).not.toHaveBeenCalled()
  })

  it.each([
    ["invalid", 400, "INVALID_OTP"],
    ["expired", 400, "OTP_EXPIRED"],
    ["too_many_attempts", 403, "TOO_MANY_ATTEMPTS"],
  ])("maps %s without running deletion", async (kind, status, error) => {
    verifyDeletionCode.mockResolvedValue({ kind })
    const response = await POST(request({ otp: "123456" }), {} as never)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
    expect(executeAccountDeletion).not.toHaveBeenCalled()
  })

  it("deletes explicitly and clears Better Auth cookies", async () => {
    const response = await POST(request({ otp: "123456" }), {} as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(executeAccountDeletion).toHaveBeenCalled()
    expect(response.headers.getSetCookie().join("\n")).toContain("better-auth.session_token=")
  })

  it("restores the consumed code when cleanup fails while the user remains", async () => {
    executeAccountDeletion.mockResolvedValue({ kind: "failed" })
    const response = await POST(request({ otp: "123456" }), {} as never)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "ACCOUNT_DELETION_FAILED" })
    expect(restoreVerifiedDeletionCode).toHaveBeenCalledWith(expect.anything(), challenge)
  })

  it("does not restore a consumed code when the failed cleanup already removed the user", async () => {
    executeAccountDeletion.mockResolvedValue({ kind: "failed" })
    getPrimaryDb.mockReturnValue({
      query: { user: { findFirst: vi.fn().mockResolvedValue(null) } },
    })

    const response = await POST(request({ otp: "123456" }), {} as never)

    expect(response.status).toBe(503)
    expect(restoreVerifiedDeletionCode).not.toHaveBeenCalled()
  })

  it("does not restore a consumed code when the live-user retry check fails", async () => {
    executeAccountDeletion.mockResolvedValue({ kind: "failed" })
    getPrimaryDb.mockReturnValue({
      query: { user: { findFirst: vi.fn().mockRejectedValue(new Error("primary down")) } },
    })

    const response = await POST(request({ otp: "123456" }), {} as never)

    expect(response.status).toBe(503)
    expect(restoreVerifiedDeletionCode).not.toHaveBeenCalled()
  })
})
