import { createElement, type AnchorHTMLAttributes } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { LandingPage } from "./landing-page"

vi.mock("next/link", () => ({
  default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    createElement("a", { ...props, "data-next-navigation": "true" }, children)
  ),
}))

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
    expect(footer?.match(/href="\/(?:pricing|blog)"/g)).toEqual([
      'href="/pricing"',
      'href="/blog"',
    ])
    expect(footer).toContain('href="https://github.com/alookai/alook"')
    expect(footer).toContain('href="https://discord.alook.ai"')
    expect(footer).toContain('href="https://x.com/alook_ai"')
    expect(footer).toContain("Share your agents with people you trust.")
  })
})

const LANDING_PROFILE_ABOUT =
  "I keep the same account, identity, and relationships across every room."

describe("landing section calls to action", () => {
  it.each([false, true])("routes all five section CTAs for signed-in=%s", (isLoggedIn) => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { isLoggedIn }))
    const links = [...markup.matchAll(/<a\b[^>]*data-testid="landing-section-cta-([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    expect(links.map((match) => match[1])).toEqual(["product", "identity", "continuity", "reach", "ownership"])
    const labels = links.map((match) => match[2])
    expect(new Set(labels).size).toBe(5)
    for (const link of links) {
      expect(link[0]).toContain(`href="${isLoggedIn ? "/c/me" : "/sign-in"}"`)
      expect(link[0]).not.toContain("data-next-navigation")
      expect(link[2].trim().split(/\s+/).length).toBeLessThanOrEqual(3)
    }
    const closing = markup.match(/<a\b[^>]*data-testid="landing-closing-open"[^>]*>/)?.[0]
    expect(closing).toContain(`href="${isLoggedIn ? "/c/me" : "/sign-in"}"`)
    expect(closing).not.toContain("data-next-navigation")
  })

  it.each([false, true])("renders Home and Templates private entries as native links for signed-in=%s", async isLoggedIn => {
    const { HeroSection } = await vi.importActual<typeof import("./hero-section")>("./hero-section")
    const { MarketingNav } = await vi.importActual<typeof import("./marketing-nav")>("./marketing-nav")
    const { TemplatesClient } = await import("@/app/templates/client")
    const { TemplateDetailClient } = await import("@/app/templates/[id]/client")
    const { TEMPLATES } = await import("@/lib/templates")
    const renderings = [
      createElement(HeroSection, { isLoggedIn, showClipboard: false, showCommunityLinks: false }),
      createElement(MarketingNav, { isLoggedIn }),
      createElement(TemplatesClient, { isLoggedIn, templates: TEMPLATES, categories: [] }),
      createElement(TemplateDetailClient, { isLoggedIn, template: TEMPLATES[0] }),
    ]
    for (const component of renderings) {
      const markup = renderToStaticMarkup(component)
      const links = [...markup.matchAll(/<a\b[^>]*href="(?:\/c\/me|\/sign-in)"[^>]*>/g)]
      expect(links).toHaveLength(1)
      expect(links[0][0]).toContain(`href="${isLoggedIn ? "/c/me" : "/sign-in"}"`)
      expect(links[0][0]).not.toContain("data-next-navigation")
      const publicLinks = [...markup.matchAll(/<a\b[^>]*href="\/templates"[^>]*>/g)]
      expect(publicLinks.length).toBeGreaterThan(0)
      expect(publicLinks.every(link => link[0].includes("data-next-navigation"))).toBe(true)
    }
  })
})
