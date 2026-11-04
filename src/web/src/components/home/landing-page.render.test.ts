import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { LandingPage } from "./landing-page"
import LandingProfileContent from "./landing-profile-content"

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
    expect(markup).not.toContain("landing-identity-card-tilt")
    const profile = renderToStaticMarkup(createElement(LandingProfileContent))
    expect(profile).toContain("Maya")
    expect(profile).toContain("Free for dinner")
    expect(profile).toContain(LANDING_PROFILE_ABOUT)
    expect(profile).not.toContain("Unknown")
  })

  it("renders logo, slogan, and social links before second-row navigation", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { isLoggedIn: false }))
    const footer = markup.match(/<footer[\s\S]*?<\/footer>/)?.[0]

    expect(footer).toBeDefined()
    expect(footer?.match(/data-testid="landing-footer-(?:brand|slogan|navigation|social)"/g)).toEqual([
      'data-testid="landing-footer-brand"',
      'data-testid="landing-footer-slogan"',
      'data-testid="landing-footer-social"',
      'data-testid="landing-footer-navigation"',
    ])
    expect(footer).toContain('aria-label="Footer navigation"')
    expect(footer?.match(/href="\/(?:pricing|blog|tutorials)"/g)).toEqual([
      'href="/pricing"',
      'href="/blog"',
      'href="/tutorials"',
    ])
    expect(footer).toContain('href="https://github.com/alookai/alook"')
    expect(footer).toContain('href="https://discord.com/invite/24PHyEHU3M"')
    expect(footer).toContain('href="https://x.com/alook_ai"')
    expect(footer.replace(/<[^>]+>/g, "")).toContain("Multi-Agent Collaboration for Team and Friends")
  })
})

const LANDING_PROFILE_ABOUT =
  "I keep the same account, identity, and relationships across every room."

describe("landing feature navigation", () => {
  it.each([false, true])("renders feature labels and the correct CTA route for signed-in=%s", (isLoggedIn) => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { isLoggedIn }))
    expect(markup).toContain("landing-section-cta-product")
    // Visible title text, with the hand-accent span stripped.
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Chat with shared agents")
    for (const label of ["Collaboration", "Agent identity", "Persistent Memory", "Remote control", "Free and local"]) {
      expect(markup).toContain(label)
    }
    const links = [...markup.matchAll(/<a\b[^>]*data-testid="landing-section-cta-([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    expect(links.map((match) => match[1])).toEqual(["product"])
    for (const link of links) {
      expect(link[0]).toContain(`href="${isLoggedIn ? "/c/me" : "/sign-in"}"`)
      expect(link[2].replace(/<[^>]+>/g, " ").trim().split(/\s+/).length).toBeLessThanOrEqual(3)
    }
    expect(markup).toContain(`href="${isLoggedIn ? "/c/me" : "/sign-in"}"`)
  })
})

describe("standalone interactive second screen", () => {
  it("inserts a pure workspace before the preserved product scene", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { isLoggedIn: false }))
    expect(Array.from(markup.matchAll(/\sid="(testimonials|workspace|product)"/g), match => match[1]))
      .toEqual(["testimonials", "workspace", "product"])
    expect(markup).not.toContain('src="/demo"')
    expect(markup).toContain("Loading Alook workspace")
    expect(markup).toContain("/landing/posters/server.webp")
    expect(markup).not.toContain("Reset demo")
    expect(markup).not.toContain("Sample conversations")
  })
})
