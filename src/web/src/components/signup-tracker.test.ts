import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  breakpoint: { current: "desktop" as "desktop" | "mobile" | "unknown" },
  queueCommunityOnboarding: vi.fn(),
  replaceRoute: vi.fn(),
  sendGTMEvent: vi.fn(),
  startCommunityOnboarding: vi.fn(),
}))
vi.mock("@next/third-parties/google", () => ({
  sendGTMEvent: (...args: unknown[]) => mocks.sendGTMEvent(...args),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replaceRoute }),
}))
vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => mocks.breakpoint.current,
}))
vi.mock("@/lib/community-onboarding", () => ({
  queueCommunityOnboarding: mocks.queueCommunityOnboarding,
  startCommunityOnboarding: mocks.startCommunityOnboarding,
}))

vi.mock("react", () => ({
  useEffect: (fn: () => void) => fn(),
}))

describe("SignupTracker", () => {
  let cookieValue = ""
  let cookieWrites: string[] = []
  const replace = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.breakpoint.current = "desktop"
    cookieValue = ""
    cookieWrites = []
    replace.mockReset()
    // @ts-expect-error stub global document
    globalThis.document = {
      get cookie() { return cookieValue },
      set cookie(value: string) {
        cookieWrites.push(value)
        if (value === "is_new_signup=; max-age=0; path=/") {
          cookieValue = cookieValue
            .split("; ")
            .filter((cookie) => !cookie.startsWith("is_new_signup="))
            .join("; ")
        }
      },
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

  it("does not consume the signup cookie while the breakpoint is unknown", async () => {
    mocks.breakpoint.current = "unknown"
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    SignupTracker({ redirectTo: "/c/me/machines" })

    expect(cookieValue).toBe("is_new_signup=email")
    expect(cookieWrites).toEqual([])
    expect(mocks.sendGTMEvent).not.toHaveBeenCalled()
    expect(mocks.queueCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.startCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.replaceRoute).not.toHaveBeenCalled()
  })

  it("consumes unknown to mobile once without automatic onboarding or redirect", async () => {
    mocks.breakpoint.current = "unknown"
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    const props = { redirectTo: "/c/me/machines" }

    SignupTracker(props)
    mocks.breakpoint.current = "mobile"
    SignupTracker(props)
    mocks.breakpoint.current = "desktop"
    SignupTracker(props)

    expect(mocks.sendGTMEvent).toHaveBeenCalledOnce()
    expect(mocks.sendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "email" })
    expect(cookieWrites).toEqual(["is_new_signup=; max-age=0; path=/"])
    expect(mocks.queueCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.startCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.replaceRoute).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("consumes unknown to desktop through the existing automatic flow", async () => {
    mocks.breakpoint.current = "unknown"
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    const props = { redirectTo: "/c/me/machines" }

    SignupTracker(props)
    mocks.breakpoint.current = "desktop"
    SignupTracker(props)

    expect(mocks.sendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "email" })
    expect(cookieWrites).toEqual(["is_new_signup=; max-age=0; path=/"])
    expect(mocks.queueCommunityOnboarding).toHaveBeenCalledOnce()
    expect(mocks.startCommunityOnboarding).toHaveBeenCalledOnce()
    expect(mocks.replaceRoute).toHaveBeenCalledWith("/c/me/machines")
    expect(replace).not.toHaveBeenCalled()
  })

  it("handles a directly resolved mobile signup without automatic navigation", async () => {
    mocks.breakpoint.current = "mobile"
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    SignupTracker({ redirectTo: "/c/me/machines" })

    expect(mocks.sendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "email" })
    expect(cookieWrites).toEqual(["is_new_signup=; max-age=0; path=/"])
    expect(mocks.queueCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.startCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.replaceRoute).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("deduplicates repeated resolved renders through cookie consumption", async () => {
    cookieValue = "is_new_signup=email"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")
    const props = { redirectTo: "/c/me/machines" }

    SignupTracker(props)
    SignupTracker(props)

    expect(mocks.sendGTMEvent).toHaveBeenCalledOnce()
    expect(cookieWrites).toEqual(["is_new_signup=; max-age=0; path=/"])
    expect(mocks.queueCommunityOnboarding).toHaveBeenCalledOnce()
    expect(mocks.startCommunityOnboarding).toHaveBeenCalledOnce()
    expect(mocks.replaceRoute).toHaveBeenCalledOnce()
  })

  it("keeps signup method tracking intact", async () => {
    cookieValue = "session=abc; is_new_signup=github; other=xyz"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")

    SignupTracker()

    expect(mocks.sendGTMEvent).toHaveBeenCalledOnce()
    expect(mocks.sendGTMEvent).toHaveBeenCalledWith({ event: "sign_up", method: "github" })
    expect(cookieWrites).toEqual(["is_new_signup=; max-age=0; path=/"])
    expect(mocks.queueCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.startCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.replaceRoute).not.toHaveBeenCalled()
  })

  it("does nothing when the signup cookie is absent", async () => {
    cookieValue = "other_cookie=value"
    vi.resetModules()
    const { SignupTracker } = await import("./signup-tracker")

    SignupTracker({ redirectTo: "/c/me/machines" })

    expect(cookieWrites).toEqual([])
    expect(mocks.sendGTMEvent).not.toHaveBeenCalled()
    expect(mocks.queueCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.startCommunityOnboarding).not.toHaveBeenCalled()
    expect(mocks.replaceRoute).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
