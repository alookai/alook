import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  underlyingSignOut: vi.fn(),
  resume: vi.fn(),
  suspend: vi.fn(),
  unregister: vi.fn(),
  readPending: vi.fn(),
  clearDesktop: vi.fn(),
  clearMobile: vi.fn(),
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
  lastLoginMethodClient: vi.fn((cfg: unknown) => ({ __plugin: "lastLoginMethodClient", cfg })),
}))

vi.mock("@/lib/community/desktop-system-notification", () => ({
  clearDesktopSystemNotificationsForViewer: mocks.clearDesktop,
}))

vi.mock("@/lib/community/mobile-system-notification", () => ({
  clearMobileSystemNotificationsForViewer: mocks.clearMobile,
  readPendingMobileSystemNotificationUnregistration: mocks.readPending,
  resumeMobileSystemNotificationRegistration: mocks.resume,
  suspendMobileSystemNotificationRegistration: mocks.suspend,
  unregisterCurrentMobileSystemNotification: mocks.unregister,
}))

import { PUSH_INSTALLATION_ID_HEADER } from "@/lib/community/notification-device-schema"
import { signOut } from "./auth-client"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.unregister.mockResolvedValue(undefined)
  mocks.clearDesktop.mockResolvedValue(undefined)
  mocks.clearMobile.mockResolvedValue(undefined)
  mocks.readPending.mockReturnValue(null)
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
  it("preserves both SDK option positions while using the logout transport", async () => {
    const onSuccess = vi.fn()
    await signOut({ fetchOptions: { onSuccess } }, { headers: { "x-request-id": "fixture" } })
    const options = mocks.underlyingSignOut.mock.calls[0][0].fetchOptions
    expect(options.onSuccess).toBe(onSuccess)
    expect(options.headers).toEqual({ "x-request-id": "fixture" })
    expect(options.customFetchImpl).toBeTypeOf("function")
  })

  it("forwards the mobile installation header on sign-out even after a pre-signout DELETE failure", async () => {
    mocks.unregister.mockRejectedValueOnce(new Error("transient 503"))
    mocks.readPending.mockReturnValueOnce({ installationId: "123e4567-e89b-42d3-a456-426614174000", queuedAt: Date.now() })
    await signOut(undefined, { headers: { "x-request-id": "fixture" } })
    const options = mocks.underlyingSignOut.mock.calls[0][0].fetchOptions
    expect(options.headers).toEqual({
      "x-request-id": "fixture",
      [PUSH_INSTALLATION_ID_HEADER]: "123e4567-e89b-42d3-a456-426614174000",
    })
  })

})
