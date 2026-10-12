import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
const mocks = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ trackLandingCtaClicked: mocks.capture }))
vi.mock("./landing-page.module.css", () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))
vi.mock("./hero-section", () => ({ HeroSection: () => null }))
vi.mock("./hero-avatar-swarm", () => ({ HeroAvatarSwarm: () => null }))
vi.mock("./homepage-faq", () => ({ HomepageFaq: () => null }))
vi.mock("./landing-reach-motion", () => ({ LandingReachMotion: () => null }))
vi.mock("./marketing-nav", () => ({ MarketingNav: () => null }))
vi.mock("./landing-shell-motion", () => ({ LandingShellMotion: () => null }))
vi.mock("./landing-footer", () => ({ LandingFooter: () => null }))
vi.mock("@/components/community/social/profile-card", () => ({ ProfileCard: () => null }))
vi.mock("@/stores/community/profile-preview", () => ({ CommunityPreviewProfileOwner: ({ children }: { children: ReactNode }) => children }))
import { LandingPage } from "./landing-page"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => vi.unstubAllGlobals())
describe("landing closing funnel entrance", () => {
  it.each([false, true])("captures the actual closing click for signed-in=%s before document navigation", isLoggedIn => {
    render(createElement(LandingPage, { isLoggedIn }))
    const anchor = screen.getByTestId("landing-closing-open")
    expect(anchor).toHaveAttribute("href", isLoggedIn ? "/c/me" : "/sign-in")
    anchor.addEventListener("click", event => event.preventDefault())
    fireEvent.click(anchor)
    expect(mocks.capture).toHaveBeenCalledWith({ cta_name: isLoggedIn ? "closing_open_app" : "closing_get_started" })
  })
})
