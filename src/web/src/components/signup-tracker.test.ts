import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockSendGTMEvent = vi.fn()
vi.mock("@next/third-parties/google", () => ({
  sendGTMEvent: (...args: unknown[]) => mockSendGTMEvent(...args),
}))

vi.mock("react", () => ({
  useEffect: (fn: () => void) => fn(),
}))

describe("SignupTracker", () => {
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

  it("fires sign_up event and clears cookie when is_new_signup is present", async () => {
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    SignupTracker()

    expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "email" })
    expect(cookieSetValue).toBe("is_new_signup=; max-age=0; path=/")
  })

  it("does nothing when is_new_signup cookie is absent", async () => {
    cookieValue = "other_cookie=value"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    SignupTracker()

    expect(mockSendGTMEvent).not.toHaveBeenCalled()
  })

  it("handles github method correctly", async () => {
    cookieValue = "session=abc; is_new_signup=github; other=xyz"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    SignupTracker()

    expect(mockSendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "github" })
  })
})
