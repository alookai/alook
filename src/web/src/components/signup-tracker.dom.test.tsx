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
vi.mock("@/lib/analytics", () => ({ trackCommunityOnboardingStarted: vi.fn() }))
vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: mocks.track }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.replace.mockReset()
  mocks.breakpoint = "desktop"
  document.cookie = "is_new_signup=; max-age=0; path=/"
  document.cookie = "is_sign_in=; max-age=0; path=/"
})

function mount(redirectTo?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, "viewer")
  const view = render(<CommunityTestProvider client={client}><SignupTracker redirectTo={redirectTo} /></CommunityTestProvider>)
  return { registry, rerender: () => view.rerender(<CommunityTestProvider client={client}><SignupTracker redirectTo={redirectTo} /></CommunityTestProvider>) }
}

describe("SignupTracker account-owned initiation", () => {
  it.each(["unknown", "mobile", "desktop"])("starts ordinary signup once before navigation with a %s breakpoint", (breakpoint) => {
    mocks.breakpoint = breakpoint
    document.cookie = "is_new_signup=email; path=/"
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(client, "viewer")
    mocks.replace.mockImplementation(() => expect(registry.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" }))
    render(<CommunityTestProvider client={client}><SignupTracker redirectTo="/c/me/machines" /></CommunityTestProvider>)
    expect(document.cookie).not.toContain("is_new_signup=")
    expect(mocks.track).toHaveBeenCalledExactlyOnceWith({ event: "sign_up", method: "email" })
    expect(registry.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" })
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me/machines")
  })

  it("does not restart mobile onboarding when the viewport changes", () => {
    mocks.breakpoint = "mobile"
    document.cookie = "is_new_signup=email; path=/"
    const { registry, rerender } = mount("/c/me/machines")
    mocks.breakpoint = "desktop"; rerender()
    mocks.breakpoint = "mobile"; rerender()
    expect(mocks.track).toHaveBeenCalledExactlyOnceWith({ event: "sign_up", method: "email" })
    expect(registry.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" })
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me/machines")
  })

  it.each(["unknown", "mobile", "desktop"])("consumes invitation signup before leaving a public page with a %s breakpoint", (breakpoint) => {
    mocks.breakpoint = breakpoint
    document.cookie = "is_new_signup=email; path=/"
    const view = render(<SignupTracker />)
    expect(document.cookie).not.toContain("is_new_signup=")
    expect(mocks.track).toHaveBeenCalledExactlyOnceWith({ event: "sign_up", method: "email" })
    expect(mocks.replace).not.toHaveBeenCalled()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(client, "viewer")
    view.rerender(<CommunityTestProvider client={client}><SignupTracker redirectTo="/c/me/machines" /></CommunityTestProvider>)
    expect(registry.runtime.ui.get().onboardingState).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledOnce()
  })

  it("deduplicates repeated resolved renders through cookie consumption", () => {
    document.cookie = "is_new_signup=email; path=/"
    const { rerender } = mount("/c/me/machines")
    rerender()
    expect(mocks.track).toHaveBeenCalledWith({ event: "sign_up", method: "email" })
    expect(mocks.replace).toHaveBeenCalledOnce()
  })

  it("reports an existing signup success marker even without an onboarding owner", () => {
    document.cookie = "is_new_signup=github; path=/"
    render(<SignupTracker />)
    expect(mocks.track).toHaveBeenCalledWith({ event: "sign_up", method: "github" })
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
  it("reports existing sign-in success and leaves onboarding untouched", () => {
    document.cookie = "is_sign_in=email_otp; path=/"
    const { registry, rerender } = mount("/c/me/machines")
    rerender()
    expect(mocks.track).toHaveBeenCalledOnce()
    expect(mocks.track).toHaveBeenCalledWith({ event: "sign_in_success", method: "email_otp" })
    expect(document.cookie).not.toContain("is_sign_in=")
    expect(registry.runtime.ui.get().onboardingState).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

})
