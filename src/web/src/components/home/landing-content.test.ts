import { readFileSync } from "node:fs"
import path from "node:path"
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
  LANDING_TYPEWRITER_CASES,
} from "./landing-content"

function webRoot() {
  return process.cwd().endsWith(`${path.sep}src${path.sep}web`)
    ? process.cwd()
    : path.join(process.cwd(), "src/web")
}

describe("landing content contract", () => {
  it("uses plain product language in the hero", () => {
    const hero = LANDING_HERO.headline

    expect(hero).toBe("Share your agents with people you trust.")
    expect(LANDING_HERO).toMatchObject({
      headlineLead: "Share your agents",
      headlineTail: "with people you trust.",
      loggedOutCta: "Start sharing",
      loggedInCta: "Open Alook",
      secondaryCta: "See how it works",
    })
    expect(LANDING_HERO.subline).toBe(
      "Bring AI agents running on your machine into a shared room, give your team a way to collaborate with them directly — a Discord-style workspace.",
    )
    expect(hero).not.toContain("Local runtimes")
    expect(hero.toLowerCase()).not.toContain("your people")
    expect(hero.toLowerCase()).not.toContain("personal company")
    expect(hero.toLowerCase()).not.toContain("orchestration layer")
  })

  it("puts social product proof before machine and provider ownership", () => {
    expect(LANDING_SECTION_ORDER).toEqual([
      "hero",
      "product-proof",
      "identity",
      "continuity",
      "reach",
      "ownership",
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

  it("frames continuity as one agent remembering and acting across rooms", () => {
    expect(LANDING_AGENT).toMatchObject({ name: "Alli", handle: "Alli#8145" })
    expect(LANDING_CONTINUITY).toMatchObject({
      kicker: "Memory with initiative",
      headline: "AI agents with memory that keep work moving",
    })
    expect(LANDING_CONTINUITY.description).toBe(
      "Your agent holds context between sessions and moves tasks forward without you repeating instructions. An inbox catches what arrives while you’re away.",
    )
  })

  it("keeps provider examples compact", () => {
    expect(LANDING_PROVIDERS).toContain("claude")
    expect(LANDING_PROVIDERS).toContain("codex")
    expect(LANDING_PROVIDERS).toContain("cursor")
  })

  it("cycles several truthful typewriter cases", () => {
    expect(LANDING_TYPEWRITER_CASES).toHaveLength(4)
    expect(LANDING_TYPEWRITER_CASES.map((story) => story.meta)).toEqual([
      "HOME / FAMILY-PLANS",
      "DIRECT MESSAGE / MAYA",
      "STUDIO / SHIPPING",
      "MY BOTS / ALLI",
    ])
    expect(LANDING_TYPEWRITER_CASES.at(-1)?.title).toBe("Alli switched to Cursor.")
    expect(LANDING_TYPEWRITER_CASES.at(-1)?.body).toContain("fresh runtime session")
  })

  it("closes with one living-room invitation instead of setup instructions", () => {
    const root = webRoot()
    const landingPageSource = readFileSync(path.join(root, "src/components/home/landing-page.tsx"), "utf8")
    const landingStyles = readFileSync(path.join(root, "src/components/home/landing-page.module.css"), "utf8")
    const companions = landingPageSource.match(/const CLOSING_COMPANIONS = \[([\s\S]*?)\] as const/)?.[1] ?? ""
    const closing = landingPageSource.match(/<section className=\{styles\.closingSection\}([\s\S]*?)<footer/)?.[1] ?? ""

    expect(closing).toContain("Ready to share")
    expect(closing).toContain("BRAND_SLOGAN")
    expect(closing).toContain("Bring AI agents you rely on into a shared workspace with the people who matter.")
    expect(closing).toContain('href={isLoggedIn ? "/c/me" : "/sign-in"}')
    expect(closing).toContain('data-testid="landing-closing-open"')
    expect(closing).toContain("LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta")
    expect(closing).toContain("CLOSING_COMPANIONS.map")
    expect(companions.match(/seed: "/g)).toHaveLength(3)
    expect(landingPageSource).not.toContain("View on GitHub")
    expect(closing).not.toContain("https://github.com/alookai/alook")
    expect(closing).not.toContain("healthy runtime")
    expect(closing).not.toContain("paired machine")
    expect(closing).not.toContain("approved DMs")
    expect(landingStyles).toMatch(/\.closingCompanionLeft\s*\{[\s\S]*?--companion-duration: 2\.45s;/)
    expect(landingStyles).toMatch(/\.closingCompanionTop\s*\{[\s\S]*?--companion-duration: 2\.85s;/)
    expect(landingStyles).toMatch(/\.closingCompanionRight\s*\{[\s\S]*?--companion-duration: 2\.65s;/)
    expect(landingStyles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.closingCompanion\s*\{[\s\S]*?animation: none;/)
    expect(landingStyles).not.toContain(".closingGathering::before")
    expect(landingStyles).toMatch(/\.closingCta > \.kicker\s*\{[\s\S]*?text-transform: none;/)
    expect(landingStyles).toMatch(/\.footer\s*\{[\s\S]*?background: var\(--landing-section-bg\);/)
    expect(landingStyles).not.toMatch(/\.footer\s*\{[\s\S]*?border-top:/)
  })

  it("keeps product-demo labels out of the homepage heading tree", () => {
    const root = webRoot()
    const shellSource = readFileSync(path.join(root, "src/components/home/landing-shell-motion.tsx"), "utf8")
    const dmHeaderSource = readFileSync(path.join(root, "src/components/community/channels/dm-header.tsx"), "utf8")
    const pairMachineSource = readFileSync(
      path.join(root, "src/components/community/machines/pair-machine-sheet.tsx"),
      "utf8",
    )

    expect(shellSource).not.toMatch(/<h[1-6]\b/)
    expect(shellSource).toContain(
      "npx --yes @alook/daemon@latest daemon start",
    )
    expect(shellSource).not.toContain("npm exec --yes --package=@alook/daemon@latest -- alook-daemon")
    expect(shellSource).not.toContain("--server-url https://alook.ai")
    expect(shellSource).not.toContain("--ws-url wss://alook.ai")
    expect(shellSource.match(/<DmHeader dm=\{DMS\[0\]\} titleAs="div" \/>/g)).toHaveLength(2)
    expect(shellSource).toContain('headingAs="div"')
    expect(dmHeaderSource).toContain('titleAs: Title = "h1"')
    expect(pairMachineSource).toContain('headingAs = "h3"')
  })

  it("keeps the approved one-H1 and seven-H2 homepage outline", () => {
    const root = webRoot()
    const landingPageSource = readFileSync(path.join(root, "src/components/home/landing-page.tsx"), "utf8")
    const heroSource = readFileSync(path.join(root, "src/components/home/hero-section.tsx"), "utf8")
    const faqSource = readFileSync(path.join(root, "src/components/home/homepage-faq.tsx"), "utf8")

    expect(heroSource.match(/<h1\b/g)).toHaveLength(1)
    expect(landingPageSource.match(/<h2\b/g)).toHaveLength(6)
    expect(faqSource.match(/<h2\b/g)).toHaveLength(1)
    expect(faqSource).toContain("<summary>")
  })

  it("requires every Lighthouse SEO audit to pass", () => {
    const root = webRoot()
    const config = JSON.parse(readFileSync(path.join(root, "lighthouserc.json"), "utf8"))

    expect(config.ci.assert.assertions["categories:seo"]).toEqual(["error", { minScore: 1 }])
  })

  it("promotes the approved landing while preserving the legacy route", () => {
    const root = webRoot()
    const repoRoot = path.resolve(root, "../..")
    const rootRoute = readFileSync(path.join(root, "src/app/(home)/page.tsx"), "utf8")
    const legacyRoute = readFileSync(path.join(root, "src/app/landing-legacy/page.tsx"), "utf8")
    const rootLayout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8")
    const authLayout = readFileSync(path.join(root, "src/app/(auth)/layout.tsx"), "utf8")
    const signInClient = readFileSync(path.join(root, "src/app/(auth)/sign-in/sign-in-client.tsx"), "utf8")
    const communityLayout = readFileSync(path.join(root, "src/app/c/layout.tsx"), "utf8")
    const ogRoute = readFileSync(path.join(root, "src/app/og/route.tsx"), "utf8")
    const ogRenderer = readFileSync(path.join(root, "src/app/_og/render-og-image.tsx"), "utf8")
    const publicLayout = readFileSync(path.join(root, "src/components/public-layout.tsx"), "utf8")
    const landingPageSource = readFileSync(path.join(root, "src/components/home/landing-page.tsx"), "utf8")
    const landingContentSource = readFileSync(path.join(root, "src/components/home/landing-content.ts"), "utf8")
    const landingStyles = readFileSync(path.join(root, "src/components/home/landing-page.module.css"), "utf8")
    const motionStyles = readFileSync(path.join(root, "src/components/home/landing-shell-motion.module.css"), "utf8")
    const reachSource = readFileSync(path.join(root, "src/components/home/landing-reach-motion.tsx"), "utf8")
    const reachStyles = readFileSync(path.join(root, "src/components/home/landing-reach-motion.module.css"), "utf8")
    const shellSource = readFileSync(path.join(root, "src/components/home/landing-shell-motion.tsx"), "utf8")
    const playbackSource = readFileSync(path.join(root, "src/components/home/use-landing-motion-playback.ts"), "utf8")
    const heroSource = readFileSync(path.join(root, "src/components/home/hero-section.tsx"), "utf8")
    const typewriterSource = readFileSync(path.join(root, "src/components/typewriter-visual.tsx"), "utf8")
    const swarmSource = readFileSync(path.join(root, "src/components/home/hero-avatar-swarm.tsx"), "utf8")
    const swarmStyles = readFileSync(path.join(root, "src/components/home/hero-avatar-swarm.module.css"), "utf8")
    const navSource = readFileSync(path.join(root, "src/components/home/marketing-nav.tsx"), "utf8")
    const legacyHome = readFileSync(path.join(root, "src/components/home/home-page.tsx"), "utf8")
    const normalizedLandingPageSource = landingPageSource.replace(/\s+/g, " ")
    const brandCopySource = readFileSync(path.join(root, "src/lib/brand-copy.ts"), "utf8")
    const manifest = JSON.parse(readFileSync(path.join(root, "public/manifest.json"), "utf8"))
    const tauriConfig = JSON.parse(
      readFileSync(path.join(repoRoot, "src/desktop/src-tauri/tauri.conf.json"), "utf8"),
    )
    const cargoManifest = readFileSync(path.join(repoRoot, "src/desktop/src-tauri/Cargo.toml"), "utf8")
    const githubPreview = readFileSync(path.join(repoRoot, "assets/social-preview/github-card.html"), "utf8")
    const readmePreview = readFileSync(path.join(repoRoot, "assets/social-preview/readme-banner.html"), "utf8")
    const twitterPreview = readFileSync(path.join(repoRoot, "assets/social-preview/twitter-banner.html"), "utf8")

    expect(rootRoute).toContain("LandingPage")
    expect(rootRoute).toContain("getSession")
    expect(rootRoute).toContain("<LandingPage isLoggedIn={!!session} />")
    expect(rootRoute).toContain('canonical: "https://alook.ai"')
    expect(rootRoute).not.toContain("HomePage")
    expect(rootRoute).not.toContain("FAQPage")
    expect(rootRoute).not.toContain("Personal Company")
    expect(legacyRoute).toContain("HomePage")
    expect(legacyRoute).toContain("getSession")
    expect(legacyRoute).toContain("index: false")
    expect(legacyRoute).toContain("follow: false")
    expect(BRAND_SLOGAN).toBe("Share your agents with people you trust.")
    expect(BRAND_TITLE).toBe("Alook — Share your agents with people you trust")
    expect(BRAND_DESCRIPTION).toContain("agents you already use")
    expect(BRAND_DESCRIPTION).toContain("shared rooms")
    expect(LANDING_META_TITLE).toBe("AI Agent Collaboration Rooms for Local Agents — Alook")
    expect(LANDING_META_DESCRIPTION).toBe(
      "Share your local AI agents with your team. Claude Code, Codex, Cursor, OpenCode, and Pi get persistent identities and memory — while running on your machine. Open source.",
    )
    expect(brandCopySource).not.toContain("Personal Company")
    expect(rootRoute).toContain("LANDING_META_TITLE")
    expect(rootRoute).toContain("LANDING_META_DESCRIPTION")
    expect(rootLayout).toContain("BRAND_TITLE")
    expect(rootLayout).toContain("BRAND_DESCRIPTION")
    expect(rootLayout).toContain("BRAND_SLOGAN")
    expect(rootLayout).not.toContain("Personal Company")
    expect(rootLayout).not.toContain("Give them an email")
    expect(rootLayout).toContain('url: "/favicon.ico", type: "image/x-icon"')
    expect(rootLayout).toContain('url: "/apple-touch-icon.png", sizes: "180x180"')
    expect(authLayout).toContain("description: BRAND_SLOGAN")
    expect(authLayout).not.toContain("Personal Company")
    expect(authLayout).not.toContain("Your Your")
    expect(signInClient).toContain('label: "Bring your own agents"')
    expect(signInClient).toContain('description: "Use your own computer and existing agent subscriptions."')
    expect(signInClient).not.toContain("Bring your own workspaces")
    expect(communityLayout).toContain('<SignupTracker redirectTo="/c/me/machines" />')
    expect(ogRoute).toContain("renderOgImage(BRAND_SLOGAN)")
    expect(ogRoute).not.toContain("searchParams")
    expect(ogRenderer).toContain('processRoot.endsWith(join("src", "web"))')
    expect(ogRenderer).toContain('join(webRoot, "public/icon-192.png")')
    expect(ogRenderer).not.toContain("OG_LOGO_DATA_URI")
    expect(ogRenderer).not.toContain("alook.svg")
    expect(ogRenderer).toContain("width={120}")
    expect(ogRenderer).toContain("height={120}")
    expect(ogRenderer).toContain("borderRadius: 28")
    expect(ogRenderer).toContain("HOME / FAMILY-PLANS")
    expect(ogRenderer).toContain("Maya joined the room.")
    expect(ogRenderer).toContain("Bring the agents you already use into a room with people you trust.")
    expect(ogRenderer).not.toContain("jarvis@alook.ai")
    expect(ogRenderer).not.toContain("you@email.com")
    expect(ogRenderer).not.toContain("stay always on")
    expect(ogRenderer).not.toContain("Personal Company")
    expect(publicLayout).toContain("BRAND_SLOGAN")
    expect(publicLayout).not.toContain("Personal Company")
    expect(manifest.name).toBe("Alook — Share your agents with people you trust")
    expect(manifest.description).toContain("people you trust")
    expect(tauriConfig.bundle.shortDescription).toBe("Share your agents with people you trust")
    expect(tauriConfig.bundle.longDescription).toContain("shared rooms")
    expect(cargoManifest).toContain('description = "Alook — Share your agents with people you trust"')
    for (const preview of [githubPreview, readmePreview, twitterPreview]) {
      expect(preview).toContain('<div class="title">Share your agents</div>')
      expect(preview).toContain('<div class="tagline">with people you trust.</div>')
      expect(preview).not.toContain("Your Personal Company")
    }
    expect(readmePreview).toContain("width: 1280px")
    expect(twitterPreview).toContain("width: 1500px")
    expect(twitterPreview).toContain("justify-content: flex-start")
    for (const preview of [readmePreview, twitterPreview]) {
      expect(preview).toContain(
        ".title {\n  color: #356f95;\n  font-family: 'VT323', monospace;",
      )
      expect(preview).toContain(
        ".tagline {\n  color: #1b271f;\n  font-family: 'VT323', monospace;",
      )
      expect(preview).not.toContain('class="spec"')
    }
    expect(readmePreview).toContain("font-size: 68px")
    expect(twitterPreview).toContain("font-size: 80px")
    expect(landingPageSource).toContain("export function LandingPage")
    expect(playbackSource).toContain("LANDING_MOTION_VISIBILITY_THRESHOLD = 0.3")
    expect(playbackSource).toContain("IntersectionObserver")
    expect(playbackSource).toContain('LandingMotionVisibility = "hidden" | "paused" | "playing"')
    expect(playbackSource).toContain('shouldReset: visibility === "hidden"')
    expect(shellSource).toContain("reducedMotion || !isPlaying")
    expect(shellSource).toContain("!reducedMotion && shouldReset")
    expect(reachSource).toContain("reducedMotion || !isPlaying")
    expect(reachSource).toContain("!reducedMotion && shouldReset")
    expect(landingPageSource).toContain("isLoggedIn={isLoggedIn}")
    expect(landingPageSource).toContain('homeHref="/"')
    expect(landingPageSource).toContain("highlightActions")
    expect(landingPageSource).toContain("FooterSocialLinks")
    expect(landingPageSource).toContain("https://github.com/alookai/alook")
    expect(landingPageSource).toContain("https://discord.alook.ai")
    expect(landingPageSource).toContain("https://x.com/alook_ai")
    expect(landingPageSource).toContain("HeroSection")
    expect(landingPageSource).toContain("<HomepageFaq />")
    expect(landingPageSource).toContain("MarketingNav")
    expect(landingPageSource).toContain("showTemplates={false}")
    expect(landingPageSource).toContain("revealAfterHero")
    expect(landingPageSource).toContain("collapseLinksOnMobile")
    expect(heroSource).toContain("TypewriterVisual")
    expect(typewriterSource).toContain("var(--tw-blob-theme, oklch(0.88 0.025 82))")
    expect(heroSource).toContain("papers={papers}")
    expect(heroSource).toContain("backgroundDecoration")
    expect(landingPageSource).toContain("<HeroAvatarSwarm />")
    expect(swarmSource).toContain("HERO_SWARM_AVATARS")
    expect(swarmSource.match(/\{ name: "/g)).toHaveLength(20)
    const swarmDurations = [...swarmSource.matchAll(/duration: "([\d.]+)s"/g)].map((match) => Number(match[1]))
    expect(swarmDurations).toHaveLength(20)
    expect(Math.min(...swarmDurations)).toBeGreaterThanOrEqual(4.5)
    expect(swarmSource).toContain('aria-hidden="true"')
    expect(swarmSource).toContain("data-path={avatar.path}")
    expect(swarmStyles).toContain("pointer-events: none")
    expect(swarmStyles).toContain("calc(100vw + 150px)")
    expect(swarmStyles).toContain("animation-fill-mode: forwards")
    expect(swarmStyles).toContain("--swarm-ground: 78%")
    expect(swarmStyles).toContain("left: calc(var(--avatar-start-x) - 64%)")
    expect(swarmStyles).toContain("scale(1.2, 0.78)")
    expect(swarmSource).toContain("styles.shadow")
    expect(swarmSource).not.toContain("styles.ground")
    expect(swarmStyles).not.toContain(".ground {")
    expect(swarmStyles).toContain("prefers-reduced-motion: reduce")
    expect(navSource).toContain("showTemplates = true")
    expect(navSource).toContain("highlightActions = false")
    expect(navSource).toContain('highlightActions ? "var(--landing-accent)" : "var(--landing-text)"')
    expect(landingStyles).toContain("max-width: 1320px")
    expect(motionStyles).toContain("--motion-frame-radius: var(--gallery-frame-radius, var(--radius-lg))")
    expect(motionStyles).toContain("clip-path: inset(0 round var(--motion-frame-radius))")
    expect(landingPageSource).toContain("papers={LANDING_TYPEWRITER_CASES.map")
    expect(landingPageSource).toContain("LANDING_HERO.headlineLead")
    expect(landingPageSource).toContain("LANDING_HERO.headlineTail")
    expect(landingPageSource).toContain("subline={LANDING_HERO.subline}")
    expect(landingPageSource).toContain("largeCtas")
    expect(landingPageSource).toContain("highlightPrimaryCta")
    expect(heroSource).toContain('highlightPrimaryCta ? "var(--landing-accent)" : "var(--landing-text)"')
    expect(landingPageSource).toContain("LandingReachMotion")
    expect(landingPageSource).not.toContain("MOBILE WEB PLACEHOLDER")
    expect(landingPageSource).not.toContain("DemoTerminal")
    expect(landingPageSource).not.toContain("/onboard.md")
    expect(landingPageSource).not.toContain("A SHARED HOME")
    expect(landingPageSource).not.toContain("Email")
    expect(landingPageSource).not.toContain("Schedule")
    expect(landingPageSource).not.toContain("same memory")
    expect(landingPageSource).not.toContain("anyone")
    expect(landingPageSource).not.toContain("subscriptions")
    expect(normalizedLandingPageSource).toContain(
      "The agent process stays on your computer, using the codebase and tools you configure for it. Alook connects it to people without moving the runtime to the cloud.",
    )
    expect(landingPageSource).not.toContain("NOT ANOTHER")
    expect(landingPageSource).not.toContain("leaves the terminal")
    expect(landingPageSource).not.toContain("Your agent gets a name")
    expect(landingPageSource).toContain("Share what already works")
    expect(landingPageSource).toContain("Invite your team to talk with your AI agents")
    expect(normalizedLandingPageSource).toContain(
      "Your agents already handle real work — Claude Code, Codex, Cursor, OpenCode, or Pi. Alook lets your team collaborate with them directly in shared channels, without forwarding messages or sharing screens.",
    )
    expect(landingPageSource).toContain("Across every room")
    expect(landingPageSource).toContain("One persistent agent identity")
    expect(landingPageSource).not.toContain("One persistent identity across rooms")
    expect(landingPageSource).toContain("I keep the same account, identity, and relationships across every room.")
    expect(landingPageSource).toContain("styles.sectionLead")
    expect(landingPageSource).toContain('<p className={styles.sectionMuted}>{LANDING_CONTINUITY.kicker}</p>')
    expect(landingPageSource).toContain("InteractiveIdentityProfileCard")
    expect(landingPageSource).toContain('name: "Maya"')
    expect(landingPageSource).toContain('userId: "maya"')
    expect(landingPageSource).not.toContain('"landing-maya"')
    expect(landingPageSource).toContain('initialStatusText="Free for dinner"')
    expect(landingPageSource).toContain("IdentityProof")
    expect(landingPageSource).toContain('data-testid="landing-identity-proof"')
    expect(landingPageSource).toContain('data-testid="landing-identity-motion"')
    expect(landingPageSource).toContain('<LandingShellMotion scene="identity" />')
    expect(landingPageSource).not.toContain('<ProductScene scene="spaces" />')
    expect(landingPageSource).toContain("ResizeObserver")
    expect(landingPageSource).toContain("--identity-card-fit-scale")
    expect(landingPageSource).toContain("styles.identityCardSlot")
    expect(landingPageSource).toContain("styles.identitySceneSlot")
    expect(landingStyles).toMatch(/\.identityMediaLayout\s*\{[\s\S]*?max-width: 1040px;/)
    expect(landingStyles).toMatch(/\.identityLayout \.sectionIntro h2\s*\{[\s\S]*?max-width: 1040px;/)
    expect(landingStyles).toMatch(/\.identityMediaLayout\s*\{[\s\S]*?align-items: stretch;/)
    expect(landingStyles).toContain("scale(var(--identity-card-fit-scale))")
    expect(landingStyles).toContain("--motion-shell-border-width: 0px")
    expect(landingStyles).toMatch(/\.productSection,\s*\.timelineSection\s*\{[\s\S]*?background: var\(--landing-section-bg/)
    expect(landingStyles).toMatch(/\.identitySection,\s*\.reachSection\s*\{[\s\S]*?background: var\(--landing-bg\)/)
    expect(landingStyles).toMatch(/\.identitySceneSlot \.galleryFrame\s*\{[\s\S]*?border: 0;/)
    expect(motionStyles).toContain("var(--motion-shell-border-width, 1px)")
    expect(landingStyles).toContain("@media (min-width: 640px) and (max-width: 1023px)")
    expect(landingStyles).toContain("@media (max-width: 639px)")
    expect(landingStyles).toMatch(
      /@media \(max-width: 639px\)[\s\S]*?\.landingHeroTypewriter\s*\{[\s\S]*?transform: translateY\(-12%\);/,
    )
    expect(landingStyles).not.toContain("translateY(-16%)")
    expect(landingStyles).toMatch(/\.identityProfileCard\s*\{[\s\S]*?width: 300px;/)
    expect(landingStyles).toMatch(/@media \(max-width: 639px\)[\s\S]*?\.identityProfileCard\s*\{[\s\S]*?width: min\(300px, 100%\);/)
    expect(landingPageSource).toContain("onPointerMove={tiltCard}")
    expect(landingPageSource).toContain("identityProfileCardSensor")
    expect(landingPageSource).toContain("Math.max(0.5")
    expect(landingStyles).toContain("inset: -72px")
    expect(landingStyles).toContain("perspective: 900px")
    expect(landingStyles).toContain("prefers-reduced-motion: reduce")
    expect(landingPageSource).toContain("styles.productLayout")
    expect(landingPageSource).not.toContain("PaletteSwitcher")
    expect(landingStyles).toMatch(/\.page\s*\{[\s\S]*?--landing-bg: #f4f9e9;/)
    expect(landingStyles).toMatch(/\.page\s*\{[\s\S]*?--landing-accent: #356f95;/)
    expect(landingStyles).toMatch(/\.page\s*\{[\s\S]*?--tw-blob-theme: var\(--landing-section-bg\);/)
    expect(landingStyles).toMatch(/\.page\s*\{[\s\S]*?--landing-text-muted: #47633b;/)
    expect(landingStyles).toMatch(/\.landingHeroEmphasis\s*\{[\s\S]*?color: var\(--landing-accent\);/)
    expect(landingStyles).toMatch(/\.landingHeroTail\s*\{[\s\S]*?color: var\(--landing-text\);/)
    expect(landingPageSource).toContain("showMobileDesktopHint={false}")
    expect(landingStyles).not.toContain("#5b6b60")
    expect(landingStyles).toContain("--landing-section-bg")
    expect(landingStyles.match(/--tw-blob-theme:/g)).toHaveLength(1)
    expect(landingPageSource).toContain('<ProductScene scene="server" />')
    expect(landingPageSource).toContain('<LandingShellMotion scene="identity" />')
    expect(landingPageSource).toContain('<ProductScene scene="machine" />')
    expect(landingPageSource).toContain('<LandingShellMotion scene="continuity" />')
    expect(landingPageSource.match(/className=\{styles\.productLayout\}/g)).toHaveLength(3)
    expect(landingPageSource).not.toContain("IdentityTimeline")
    expect(shellSource).toContain("continuity-frontend-design")
    expect(shellSource).toContain("I’ll ask Shelly for today’s A/B conversion update")
    expect(shellSource).toContain("then check with Tracy about the home router")
    expect(shellSource).toContain("A/B landing pages converting today")
    expect(shellSource).toContain("router at home still dropping out")
    expect(shellSource).toContain("<InboxPopover")
    expect(shellSource).toContain('data-motion-target", "continuity-inbox"')
    expect(shellSource).toContain(
      'inbox={scene === "continuity" || scene === "server" || scene === "machine" ? <span /> : undefined}',
    )
    expect(landingPageSource).not.toContain("ProductGallery")
    expect(landingPageSource).not.toContain("storyTabs")
    expect(landingPageSource).toContain("The same room")
    expect(landingPageSource).toContain("AI agents on desktop and phone")
    expect(normalizedLandingPageSource).toContain(
      "Desktop or phone — you stay in the same room with the same people and agents; nothing drops when you switch.",
    )
    expect(reachSource).toContain("<p>Desktop</p>")
    expect(shellSource).toContain("<span>Phone</span>")
    expect(`${reachSource} ${shellSource}`).not.toContain("Alook Web")
    expect(reachSource).toContain('<LandingShellMotion scene="server" beat={beat} />')
    expect(reachSource).toContain("<LandingMobileChatMotion beat={beat} />")
    expect(shellSource).toContain('data-testid="landing-mobile-motion-stage"')
    expect(shellSource).toContain("onBack={() => {}}")
    expect(shellSource).toContain("stage.getBoundingClientRect().width / 390")
    expect(motionStyles).toContain("transform: scale(var(--mobile-stage-scale))")
    expect(motionStyles).toMatch(/\.mobileMessages\s*\{[\s\S]*?justify-content: flex-start;/)
    expect(reachStyles).toContain("width: clamp(148px, 42%, 196px)")
    expect(reachStyles).toContain("clamp(-220px, -42vw, -160px)")
    expect(reachStyles).toContain("width: clamp(96px, 24%, 224px)")
    expect(reachStyles).toContain("right: clamp(20px, 12%, 120px)")
    expect(reachStyles).toContain("bottom: clamp(24px, 8%, 64px)")
    expect(reachStyles).toContain("aspect-ratio: 1120 / 760")
    expect(reachStyles).toContain("clamp(12px, 4vw, 24px)")
    expect(reachStyles).toMatch(/\.desktopShell\s*\{[\s\S]*?left: 9%;/)
    expect(landingPageSource).toContain("BRAND_SLOGAN")
    expect(landingPageSource).toContain("Alook holds the room")
    expect(landingPageSource).toContain("Run AI agents locally on your machine")
    expect(landingPageSource).toContain("styles.ownershipDescription")
    expect(landingPageSource).not.toContain("The runtime and workspace stay on your paired machine")
    expect(`${landingPageSource} ${landingContentSource}`).not.toMatch(/\bconversations?\b/i)
    expect(`${landingPageSource} ${landingContentSource}`).not.toMatch(/\bplaces?\b/i)
    expect(landingPageSource).not.toContain("stay in touch")
    expect(legacyHome).toContain("export function HomePage")
  })
})
