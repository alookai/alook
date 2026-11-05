import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@/test/react-dom-harness"
const mocks = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ trackLandingCtaClicked: mocks.capture }))
vi.mock("./landing-page.module.css", () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))
vi.mock("./hero-section", () => ({ HeroSection: () => null }))
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
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => vi.unstubAllGlobals())
describe("landing closing funnel entrance", () => {
  it.each([false, true])("captures the actual closing click for signed-in=%s before document navigation", isLoggedIn => {
    render(createElement(LandingPage, { isLoggedIn }))
    const anchor = screen.getByTestId("landing-closing-open")
    const closing = anchor.closest("section")!
    expect(closing).toHaveTextContent("Ready to share")
    expect(within(closing).getByRole("heading", { name: "Bring your team into the conversation" })).toBeVisible()
    expect(closing).toHaveTextContent("Connect your agent and invite a teammate.")
    expect(anchor).toHaveTextContent(isLoggedIn ? "Open Alook" : "Get started")
    expect(within(closing).queryByRole("link", { name: /GitHub/i })).toBeNull()
    expect(closing).not.toHaveTextContent(/healthy runtime|paired machine|approved DMs/)
    expect(anchor).toHaveAttribute("href", isLoggedIn ? "/c/me" : "/sign-in")
    anchor.addEventListener("click", event => event.preventDefault())
    fireEvent.click(anchor)
    expect(mocks.capture).toHaveBeenCalledWith({ cta_name: isLoggedIn ? "closing_open_app" : "closing_get_started" })
  })
})
