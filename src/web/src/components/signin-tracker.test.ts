import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockSendGTMEvent = vi.fn()
vi.mock("@next/third-parties/google", () => ({
  sendGTMEvent: (...args: unknown[]) => mockSendGTMEvent(...args),
}))

vi.mock("react", () => ({
  useEffect: (fn: () => void) => fn(),
}))

describe("SigninTracker", () => {
  let cookieValue = ""
  let cookieSetValue = ""

  beforeEach(() => {
    vi.clearAllMocks()
    cookieValue = ""
    cookieSetValue = ""
    // @ts-expect-error stub global document
    globalThis.document = {
      get cookie() { return cookieValue },
      set cookie(val: string) { cookieSetValue = val },
    }
  })

  afterEach(() => {
    // @ts-expect-error cleanup
    delete globalThis.document
  })

  it("fires sign_in_success event and clears cookie when is_sign_in is present", async () => {
    cookieValue = "is_sign_in=email_otp"
    vi.resetModules()
    const { SigninTracker } = await import("./signin-tracker")
    SigninTracker()

    expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_in_success", method: "email_otp" })
    expect(cookieSetValue).toBe("is_sign_in=; max-age=0; path=/")
  })

  it("does nothing when is_sign_in cookie is absent", async () => {
    cookieValue = "other_cookie=value"
    vi.resetModules()
    const { SigninTracker } = await import("./signin-tracker")
    SigninTracker()

    expect(mockSendGTMEvent).not.toHaveBeenCalled()
  })

  it("handles github method correctly", async () => {
    cookieValue = "session=abc; is_sign_in=github; other=xyz"
    vi.resetModules()
    const { SigninTracker } = await import("./signin-tracker")
    SigninTracker()

    expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_in_success", method: "github" })
  })

  it("handles google method correctly", async () => {
    cookieValue = "is_sign_in=google"
    vi.resetModules()
    const { SigninTracker } = await import("./signin-tracker")
    SigninTracker()

    expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_in_success", method: "google" })
  })
})
