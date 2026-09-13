import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  underlyingSignOut: vi.fn(),
  resume: vi.fn(),
  suspend: vi.fn(),
  unregister: vi.fn(),
}))

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: {},
    signUp: {},
    signOut: mocks.underlyingSignOut,
    useSession: vi.fn(),
  }),
}))

vi.mock("better-auth/client/plugins", () => ({
  emailOTPClient: vi.fn(() => ({})),
  deviceAuthorizationClient: vi.fn(() => ({})),
}))

vi.mock("@/lib/community/mobile-system-notification", () => ({
  resumeMobileSystemNotificationRegistration: mocks.resume,
  suspendMobileSystemNotificationRegistration: mocks.suspend,
  unregisterCurrentMobileSystemNotification: mocks.unregister,
}))

import { signOut } from "./auth-client"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.unregister.mockResolvedValue(undefined)
  mocks.underlyingSignOut.mockResolvedValue({ data: null, error: null })
})

describe("auth client sign out", () => {
  it("deletes the mobile installation before clearing the old session", async () => {
    const calls: string[] = []
    mocks.unregister.mockImplementation(async () => { calls.push("delete") })
    mocks.underlyingSignOut.mockImplementation(async () => {
      calls.push("sign-out")
      return { data: null, error: null }
    })

    await signOut()
    expect(calls).toEqual(["delete", "sign-out"])
    expect(mocks.suspend).toHaveBeenCalledOnce()
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it("keeps logout best-effort when mobile cleanup is unavailable", async () => {
    mocks.unregister.mockRejectedValue(new Error("native unavailable"))
    await expect(signOut()).resolves.toEqual({ data: null, error: null })
    expect(mocks.underlyingSignOut).toHaveBeenCalledOnce()
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it("resumes mobile registration when sign out returns an error", async () => {
    const result = { data: null, error: { message: "auth failed" } }
    mocks.underlyingSignOut.mockResolvedValue(result)

    await expect(signOut()).resolves.toBe(result)
    expect(mocks.resume).toHaveBeenCalledOnce()
  })

  it("resumes mobile registration when sign out throws", async () => {
    const error = new Error("auth failed")
    mocks.underlyingSignOut.mockRejectedValue(error)

    await expect(signOut()).rejects.toBe(error)
    expect(mocks.resume).toHaveBeenCalledOnce()
  })
})
