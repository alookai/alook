import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { LandingPage } from "./landing-page"

vi.mock("./landing-page.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("./hero-section", () => ({ HeroSection: () => null }))
vi.mock("./hero-avatar-swarm", () => ({ HeroAvatarSwarm: () => null }))
vi.mock("./homepage-faq", () => ({ HomepageFaq: () => null }))
vi.mock("./landing-reach-motion", () => ({ LandingReachMotion: () => null }))
vi.mock("./marketing-nav", () => ({ MarketingNav: () => null }))
vi.mock("./landing-shell-motion", async () => {
  const { createElement } = await import("react")
  return {
    LandingShellMotion: () => createElement("div", { "data-testid": "landing-identity-motion" }),
  }
})

describe("landing identity profile preview", () => {
  it("renders the static Maya profile without consulting live profile state", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { isLoggedIn: false }))
    const identityCard = markup.match(
      /data-testid="landing-identity-card-tilt"[\s\S]*?data-testid="landing-identity-motion"/,
    )?.[0]

    expect(identityCard).toBeDefined()
    expect(identityCard).toContain("Maya")
    expect(identityCard).toContain("Free for dinner")
    expect(identityCard).toContain(LANDING_PROFILE_ABOUT)
    expect(identityCard).not.toContain("Unknown")
  })
})

const LANDING_PROFILE_ABOUT =
  "I keep the same account, identity, and relationships across every room."
