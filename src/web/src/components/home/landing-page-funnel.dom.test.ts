import { createElement, type MouseEvent as ReactMouseEvent } from "react"
import { aroundEach, beforeEach, describe, expect, it, vi } from "vitest"
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
import { LandingPage } from "./landing-page"

beforeEach(() => {
  mocks.capture.mockReset()
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
})
aroundEach(async run => {
  try { await run() }
  finally {
    try { await vi.dynamicImportSettled() }
    finally { vi.unstubAllGlobals() }
  }
})
describe("landing closing funnel entrance", () => {
  it.each([false, true])("captures the actual closing click for signed-in=%s before document navigation", isLoggedIn => {
    render(createElement("div", { onClick: (event: ReactMouseEvent) => event.preventDefault() },
      createElement(LandingPage, { isLoggedIn })))
    const heading = screen.getByRole("heading", { name: "Bring your team into the conversation" })
    const closing = heading.closest("section")!
    const anchor = within(closing).getByRole("link", { name: isLoggedIn ? "Open Alook" : "Get started", exact: true })
    expect(closing).toHaveTextContent("Ready to share")
    expect(within(closing).getByRole("heading", { name: "Bring your team into the conversation" })).toBeVisible()
    expect(closing).toHaveTextContent("Connect your agent and invite a teammate.")
    expect(anchor).toHaveTextContent(isLoggedIn ? "Open Alook" : "Get started")
    expect(within(closing).queryByRole("link", { name: /GitHub/i })).toBeNull()
    expect(anchor).toHaveAttribute("href", isLoggedIn ? "/c/me" : "/sign-in")
    expect(mocks.capture).not.toHaveBeenCalled()
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    expect(event.defaultPrevented).toBe(false)
    fireEvent(anchor, event)
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(mocks.capture).toHaveBeenCalledWith({ cta_name: isLoggedIn ? "closing_open_app" : "closing_get_started" })
  })
})
