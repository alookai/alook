
import resolvedRawInput0 from "../community/machines/pair-machine-sheet.tsx?raw"
import staticContractInput0 from "./landing-page.tsx?raw"
import staticContractInput1 from "./hero-section.tsx?raw"
import staticContractInput2 from "./landing-page.module.css?raw"
import staticContractInput3 from "./landing-shell-motion.tsx?raw"
import staticContractInput4 from "../community/channels/dm-header.tsx?raw"
import staticContractInput5 from "./homepage-faq.tsx?raw"
import staticContractInput6 from "./landing-testimonials.tsx?raw"
import staticContractInput7 from "../../../lighthouserc.json?raw"
import staticContractInput8 from "../../app/(home)/page.tsx?raw"
import staticContractInput9 from "../../app/landing-legacy/page.tsx?raw"
import staticContractInput10 from "../../app/layout.tsx?raw"
import staticContractInput11 from "../../lib/seo/site-metadata.ts?raw"
import staticContractInput12 from "../../app/(auth)/layout.tsx?raw"
import staticContractInput13 from "../../app/(auth)/sign-in/sign-in-client.tsx?raw"
import staticContractInput17 from "../../app/_og/render-og-image.tsx?raw"
import staticContractInput18 from "../public-layout.tsx?raw"
import staticContractInput31 from "../../../public/manifest.json?raw"
import staticContractInput32 from "../../../../desktop/src-tauri/tauri.conf.json?raw"
import staticContractInput33 from "../../../../desktop/src-tauri/Cargo.toml?raw"
import staticContractInput34 from "../../../../../assets/social-preview/github-card.html?raw"
import staticContractInput35 from "../../../../../assets/social-preview/readme-banner.html?raw"
import staticContractInput36 from "../../../../../assets/social-preview/twitter-banner.html?raw"
import { describe, expect, it } from "vitest"
import { BRAND_DESCRIPTION, BRAND_SLOGAN, BRAND_TITLE } from "@/lib/brand-copy"
import {
  LANDING_META_DESCRIPTION,
  LANDING_META_TITLE,
  LANDING_AGENT,
  LANDING_CONTINUITY,
  LANDING_GALLERY,
  LANDING_HERO,
  LANDING_MACHINE_INTRO,
  LANDING_PROVIDERS,
  LANDING_SECTION_ORDER,
} from "./landing-content"


describe("landing content contract", () => {
  it("uses plain product language in the hero", () => {
    const hero = LANDING_HERO.headline

    expect(hero).toBe("Multi-Agent Collaboration for Team and Friends")
    expect(LANDING_HERO).toMatchObject({
      headlineLead: "Multi-Agent Collaboration",
      headlineTail: "for Team and Friends",
      loggedOutCta: "Get started",
      loggedInCta: "Open Alook",
      secondaryCta: "View on GitHub",
    })
  })

  it("puts social product proof before machine and provider ownership", () => {
    expect(LANDING_SECTION_ORDER).toEqual([
      "hero",
      "testimonials",
      "workspace",
      "features",
      "faq",
      "closing",
    ])
    expect(LANDING_GALLERY.map((story) => story.scene)).toEqual([
      "server",
      "spaces",
      "provider",
      "machine",
    ])
    expect(LANDING_GALLERY.every((story) => !("description" in story))).toBe(true)
    expect(LANDING_MACHINE_INTRO).toContain("machine and daemon are online")
    expect(LANDING_MACHINE_INTRO).not.toContain("always-on")
  })

  it("uses the tracked GitHub repository link for the hero secondary CTA", () => {
    const landingPageSource = staticContractInput0
    const heroSource = staticContractInput1

    expect(landingPageSource).toContain('secondaryCta={{ kind: "github", label: LANDING_HERO.secondaryCta }}')
    expect(landingPageSource).not.toContain('secondaryCta={{ href: "#product"')
    expect(heroSource).toMatch(
      /<GithubOutboundLink[\s\S]*?surface="landing"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?<\/GithubOutboundLink>/,
    )
  })

  it("frames continuity as one agent remembering and acting across rooms", () => {
    expect(LANDING_AGENT).toMatchObject({ name: "Alli", handle: "Alli#8145" })
    expect(LANDING_CONTINUITY).toMatchObject({
      kicker: "Keep the context",
      headline: "Pick up where you left off.",
    })
    expect(LANDING_CONTINUITY.description).toBe(
      "Your agent uses earlier conversations and saved notes to check with teammates and bring back an update.",
    )
  })

  it("keeps provider examples compact", () => {
    expect(LANDING_PROVIDERS).toEqual([
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "grok", label: "Grok Build" },
      { id: "cursor", label: "Cursor" },
      { id: "opencode", label: "OpenCode" },
      { id: "pi", label: "Pi" },
    ])
  })

  it("disables closing decoration for reduced motion", () => {
    expect(staticContractInput2).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.closingCompanion\s*\{[\s\S]*?animation: none;/)
  })

  it("keeps product-demo labels out of the homepage heading tree", () => {
    const shellSource = staticContractInput3
    const dmHeaderSource = staticContractInput4
    const pairMachineSource = resolvedRawInput0

    expect(shellSource).not.toMatch(/<h[1-6]\b/)
    expect(shellSource).toContain(
      "npx --yes @alook/daemon@latest daemon start",
    )
    expect(shellSource).not.toContain("npm exec --yes --package=@alook/daemon@latest -- alook-daemon")
    expect(shellSource).not.toContain("--server-url https://alook.ai")
    expect(shellSource).not.toContain("--ws-url wss://alook.ai")
    expect(shellSource).toContain('headingAs="div"')
    expect(dmHeaderSource).toContain('titleAs: Title = "h1"')
    expect(pairMachineSource).toContain('headingAs = "h3"')
  })

  it("keeps one H1 and includes the testimonials in the shorter homepage outline", () => {
    const landingPageSource = staticContractInput0
    const heroSource = staticContractInput1
    const faqSource = staticContractInput5
    const testimonialsSource = staticContractInput6

    expect(heroSource.match(/<h1\b/g)).toHaveLength(1)
    expect(landingPageSource.match(/<h2\b/g)).toHaveLength(1)
    expect(faqSource.match(/<h2\b/g)).toHaveLength(1)
    expect(testimonialsSource.match(/<h2\b/g)).toHaveLength(1)
    expect(landingPageSource.indexOf("<LandingTestimonials />")).toBeLessThan(landingPageSource.indexOf("<HomepageFaq />"))
    expect(faqSource).toContain("<summary>")
  })

  it("requires every Lighthouse SEO audit to pass", () => {
    const config = JSON.parse(staticContractInput7)

    expect(config.ci.collect.startServerReadyPattern).toBe(
      "Alook multi-zone Next development ready",
    )
    expect(config.ci.collect.startServerReadyTimeout).toBe(90_000)
    expect(config.ci.assert.assertions["categories:seo"]).toEqual(["error", { minScore: 1 }])
  })

  it("keeps public and legacy routes plus cross-platform brand metadata aligned", () => {
    const rootRoute = staticContractInput8
    const legacyRoute = staticContractInput9
    expect(rootRoute).toContain("<SessionLandingPage />")
    expect(rootRoute).not.toContain("getSession")
    expect(rootRoute).toContain('path: "/"')
    expect(legacyRoute).toContain("HomePage")
    expect(legacyRoute).toContain("getSession")
    expect(legacyRoute).toContain("index: false")
    expect(legacyRoute).toContain("follow: false")
    expect(BRAND_SLOGAN).toBe("Multi-Agent Collaboration for Team and Friends")
    expect(BRAND_TITLE).toBe("Alook | Multi-Agent Collaboration for Team and Friends")
    expect(BRAND_DESCRIPTION).toContain("agents you already use")
    expect(BRAND_DESCRIPTION).toContain("shared rooms")
    expect(LANDING_HERO.subline).toBe("Chat with your team, friends, and agents like Claude Code and Codex in one place. No more relaying messages.")
    expect(LANDING_META_TITLE).toBe("Alook | Multi-Agent Collaboration for Team and Friends")
    expect(LANDING_META_DESCRIPTION).toBe("Bring Claude Code and Codex agents into shared chats with Alook. Coordinate multi-agent workflows, share context, and review work with your team.")
    expect(rootRoute).toContain("LANDING_META_TITLE")
    expect(rootRoute).toContain("LANDING_META_DESCRIPTION")
    expect(staticContractInput10).toContain("siteMetadata")
    expect(staticContractInput11).toContain("BRAND_TITLE")
    expect(staticContractInput11).toContain("BRAND_DESCRIPTION")
    expect(staticContractInput11).toContain("BRAND_SLOGAN")
    expect(staticContractInput11).toContain('url: "/favicon.ico", type: "image/x-icon"')
    expect(staticContractInput11).toContain('url: "/apple-touch-icon.png", sizes: "180x180"')
    expect(staticContractInput12).toContain("description: BRAND_SLOGAN")
    expect(staticContractInput13).toContain('label: "Bring your own agents"')
    expect(staticContractInput13).toContain('description: "Use your own computer and existing agent subscriptions."')
    expect(staticContractInput17).toContain("BRAND_SLOGAN")
    expect(staticContractInput18).toContain("BRAND_SLOGAN")
    const manifest = JSON.parse(staticContractInput31)
    const tauri = JSON.parse(staticContractInput32)
    expect(manifest.name).toBe("Alook | Multi-Agent Collaboration for Team and Friends")
    expect(manifest.description).toContain("people you trust")
    expect(tauri.bundle.shortDescription).toBe("Multi-Agent Collaboration for Team and Friends")
    expect(tauri.bundle.longDescription).toContain("shared rooms")
    expect(staticContractInput33).toContain('description = "Alook | Multi-Agent Collaboration for Team and Friends"')
    for (const preview of [staticContractInput34, staticContractInput35, staticContractInput36]) {
      expect(preview).toContain('<div class="title">Multi-Agent Collaboration</div>')
      expect(preview).toContain('<div class="tagline">for Team and Friends</div>')
      expect(preview).not.toContain("Your Personal Company")
    }
    expect(staticContractInput35).toContain("width: 1280px")
    expect(staticContractInput36).toContain("width: 1500px")
  })
})
