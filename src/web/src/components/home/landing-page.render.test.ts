import { JSDOM } from "jsdom"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { LandingPage } from "./landing-page"
import LandingProfileContent from "./landing-profile-content"

vi.mock("./landing-page.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("./hero-section", () => ({ HeroSection: () => null }))
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
  it("renders the actual Maya preview identity, bio, and status", () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(LandingProfileContent)), { url: "https://alook.invalid/" })
    try {
      const card = dom.window.document.querySelector(`[data-testid="${tid.profileCard}"]`)
      expect(card).not.toBeNull()
      const bio = card!.querySelector("p")
      expect(bio?.textContent).toBe(LANDING_PROFILE_ABOUT)
      expect(bio?.previousElementSibling?.textContent).toBe("Maya")
      expect(card!.querySelector(`[data-testid="${tid.statusPill}"]`)?.textContent).toBe("Free for dinner")
    } finally {
      dom.window.close()
    }
  })

  it("renders logo, slogan, and social links before second-row navigation", () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(LandingPage, { isLoggedIn: false })), { url: "https://alook.invalid/" })
    try {
      const footer = dom.window.document.querySelector("footer")
      expect(footer).not.toBeNull()
      const brand = footer!.querySelector('a[aria-label="Alook home"]')
      const slogan = Array.from(footer!.querySelectorAll("p")).find(element => element.textContent === "Multi-Agent Collaboration for Team and Friends")
      const social = footer!.querySelector('[aria-label="Alook social links"]')
      const navigation = footer!.querySelector('nav[aria-label="Footer navigation"]')
      expect(brand?.textContent).toBe("Alook")
      expect(brand?.getAttribute("href")).toBe("/")
      expect(slogan).toBeDefined()
      expect(social).not.toBeNull()
      expect(navigation).not.toBeNull()
      const links = Array.from(social!.querySelectorAll("a"))
      expect(links).toHaveLength(3)
      expect(links.map(link => ({ name: link.getAttribute("aria-label"), href: link.getAttribute("href") })).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")))
        .toEqual([
          { name: "Discord", href: "https://discord.com/invite/24PHyEHU3M" },
          { name: "Follow us on X", href: "https://x.com/alook_ai" },
          { name: "GitHub", href: "https://github.com/alookai/alook" },
        ])
      expect(Array.from(navigation!.querySelectorAll("a"), link => ({ name: link.textContent?.trim(), href: link.getAttribute("href") })))
        .toEqual([
          { name: "Download", href: "/download" },
          { name: "Pricing", href: "/pricing" },
          { name: "Blog", href: "/blog" },
          { name: "Contact", href: "/contact" },
          { name: "Tutorials", href: "/tutorials" },
        ])
      const ordered = [brand!, slogan!, social!, navigation!]
      for (let index = 1; index < ordered.length; index++) {
        expect(ordered[index - 1].compareDocumentPosition(ordered[index]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      }
    } finally {
      dom.window.close()
    }
  })
})

const LANDING_PROFILE_ABOUT =
  "I keep the same account, identity, and relationships across every room."

describe("landing feature navigation", () => {
  it.each([false, true])("renders feature labels and the correct CTA route for signed-in=%s", (isLoggedIn) => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(LandingPage, { isLoggedIn })), { url: "https://alook.invalid/" })
    try {
      const features = dom.window.document.querySelector('section[aria-label="Explore Alook features"]')
      expect(features).not.toBeNull()
      const tabs = features!.querySelector('[role="tablist"][aria-label="Features"]')
      expect(tabs).not.toBeNull()
      expect(Array.from(tabs!.querySelectorAll('[role="tab"]'), tab => tab.textContent).sort())
        .toEqual(["Agent identity", "Collaboration", "Free and local", "Persistent Memory", "Remote control"])
      const selected = tabs!.querySelectorAll('[role="tab"][aria-selected="true"]')
      expect(selected).toHaveLength(1)
      expect(selected[0].textContent).toBe("Collaboration")
      const panels = features!.querySelectorAll('[role="tabpanel"]')
      expect(panels).toHaveLength(1)
      const panel = panels[0]
      expect(panel.getAttribute("aria-labelledby")).toBe(selected[0].id)
      expect(panel.querySelector("h2")?.textContent).toBe("Chat with shared agents")
      const links = panel.querySelectorAll("a")
      expect(links).toHaveLength(1)
      expect(links[0].textContent).toBe("Share your agent")
      expect(links[0].getAttribute("href")).toBe(isLoggedIn ? "/c/me" : "/sign-in")
      expect(panel.querySelector(`[data-testid="${tid.profileCard}"]`)).toBeNull()
    } finally {
      dom.window.close()
    }
  })
})

describe("standalone interactive second screen", () => {
  it("reserves the loading workspace before the initial product scene", () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(LandingPage, { isLoggedIn: false })), { url: "https://alook.invalid/" })
    try {
      const document = dom.window.document
      expect(Array.from(document.querySelectorAll("main > section[id]"), section => section.id))
        .toEqual(["testimonials", "workspace", "value", "product"])
      const workspace = document.querySelector('section[aria-label="Explore Alook"]')
      expect(workspace).not.toBeNull()
      expect(workspace!.querySelector("iframe")).toBeNull()
      const loading = workspace!.querySelector('[role="status"][aria-label="Loading Alook workspace"]')
      expect(loading).not.toBeNull()
      expect(loading?.parentElement?.getAttribute("aria-busy")).toBe("true")
      const product = document.querySelector('section[aria-label="Explore Alook features"] [role="tabpanel"]')
      expect(product).not.toBeNull()
      expect(product!.querySelector('img[src="/landing/posters/server.webp"]')).not.toBeNull()
    } finally {
      dom.window.close()
    }
  })
})
