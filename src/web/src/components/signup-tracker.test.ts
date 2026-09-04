import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockSendGTMEvent = vi.fn()
const replaceRoute = vi.fn()
const queueCommunityOnboarding = vi.fn()
const startCommunityOnboarding = vi.fn()
vi.mock("@next/third-parties/google", () => ({
  sendGTMEvent: (...args: unknown[]) => mockSendGTMEvent(...args),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceRoute }),
}))
vi.mock("@/lib/community-onboarding", () => ({
  queueCommunityOnboarding,
  startCommunityOnboarding,
}))

vi.mock("react", () => ({
  useEffect: (fn: () => void) => fn(),
}))

describe("SignupTracker", () => {
  let cookieValue = ""
  let cookieSetValue = ""
  const replace = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    cookieValue = ""
    cookieSetValue = ""
    replace.mockReset()
    replaceRoute.mockReset()
    queueCommunityOnboarding.mockReset()
    startCommunityOnboarding.mockReset()
    // @ts-expect-error stub global document
    globalThis.document = {
      get cookie() { return cookieValue },
      set cookie(val: string) { cookieSetValue = val },
    }
    // @ts-expect-error stub global window
    globalThis.window = { location: { replace } }
  })

  afterEach(() => {
    // @ts-expect-error cleanup
    delete globalThis.document
    // @ts-expect-error cleanup
    delete globalThis.window
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

  it("redirects a new signup when the host surface provides a landing", async () => {
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    SignupTracker({ redirectTo: "/c/me/machines" })

    expect(queueCommunityOnboarding).toHaveBeenCalledOnce()
    expect(startCommunityOnboarding).toHaveBeenCalledOnce()
    expect(replaceRoute).toHaveBeenCalledWith("/c/me/machines")
    expect(replace).not.toHaveBeenCalled()
    expect(cookieSetValue).toBe("is_new_signup=; max-age=0; path=/")
  })
})
