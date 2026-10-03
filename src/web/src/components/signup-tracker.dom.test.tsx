import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { SignupTracker } from "./signup-tracker"

const mocks = vi.hoisted(() => ({ breakpoint: "desktop", replace: vi.fn(), track: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/lib/analytics", () => ({ trackSignUp: mocks.track, trackCommunityOnboardingStarted: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.replace.mockReset()
  mocks.breakpoint = "desktop"
  document.cookie = "is_new_signup=; max-age=0; path=/"
})

function mount(redirectTo?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, "viewer")
  const view = render(<CommunityTestProvider client={client}><SignupTracker redirectTo={redirectTo} /></CommunityTestProvider>)
  return { registry, rerender: () => view.rerender(<CommunityTestProvider client={client}><SignupTracker redirectTo={redirectTo} /></CommunityTestProvider>) }
}

describe("SignupTracker account-owned initiation", () => {
  it("does not consume the signup cookie while the breakpoint is unknown", () => {
    mocks.breakpoint = "unknown"
    document.cookie = "is_new_signup=email; path=/"
    const { registry } = mount("/c/me/machines")
    expect(document.cookie).toContain("is_new_signup=email")
    expect(mocks.track).not.toHaveBeenCalled()
    expect(registry.runtime.ui.get().onboardingState).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("consumes unknown to mobile once without automatic onboarding or redirect", () => {
    mocks.breakpoint = "unknown"
    document.cookie = "is_new_signup=email; path=/"
    const { registry, rerender } = mount("/c/me/machines")
    mocks.breakpoint = "mobile"; rerender()
    mocks.breakpoint = "desktop"; rerender()
    expect(mocks.track).toHaveBeenCalledOnce()
    expect(registry.runtime.ui.get().onboardingState).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("consumes unknown to desktop through the actual owner before navigation", () => {
    mocks.breakpoint = "unknown"
    document.cookie = "is_new_signup=email; path=/"
    const { registry, rerender } = mount("/c/me/machines")
    mocks.replace.mockImplementation(() => expect(registry.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" }))
    mocks.breakpoint = "desktop"; rerender()
    expect(mocks.track).toHaveBeenCalledWith("email")
    expect(registry.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" })
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
  })

  it("handles a directly resolved mobile signup without automatic navigation", () => {
    mocks.breakpoint = "mobile"
    document.cookie = "is_new_signup=email; path=/"
    const { registry } = mount("/c/me/machines")
    expect(mocks.track).toHaveBeenCalledWith("email")
    expect(registry.runtime.ui.get().onboardingState).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("deduplicates repeated resolved renders through cookie consumption", () => {
    document.cookie = "is_new_signup=email; path=/"
    const { rerender } = mount("/c/me/machines")
    rerender()
    expect(mocks.track).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledOnce()
  })

  it("keeps signup method tracking intact on a public entry without an owner", () => {
    document.cookie = "is_new_signup=github; path=/"
    render(<SignupTracker />)
    expect(mocks.track).toHaveBeenCalledWith("github")
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("does nothing when the signup cookie is absent", () => {
    const { registry } = mount("/c/me/machines")
    expect(mocks.track).not.toHaveBeenCalled()
    expect(registry.runtime.ui.get().onboardingState).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("starts once and redirects when sessionStorage rejects all writes", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    document.cookie = "is_new_signup=email; path=/"
    const { registry, rerender } = mount("/c/me/machines")
    rerender()
    expect(registry.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" })
    expect(write).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledOnce()
    write.mockRestore()
  })
})
