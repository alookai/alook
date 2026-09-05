"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"
import { GeneratedAvatar } from "@/components/avatar"
import { ProfileCard } from "@/components/community/social/profile-card"
import { ProviderLogo } from "@/components/provider-logo"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { HeroSection } from "./hero-section"
import { HeroAvatarSwarm } from "./hero-avatar-swarm"
import { HomepageFaq } from "./homepage-faq"
import { LandingReachMotion } from "./landing-reach-motion"
import { LandingShellMotion } from "./landing-shell-motion"
import { MarketingNav } from "./marketing-nav"
import { BRAND_SLOGAN } from "@/lib/brand-copy"
import {
  LANDING_CONTINUITY,
  LANDING_GALLERY,
  LANDING_HERO,
  LANDING_MACHINE_INTRO,
  LANDING_PROVIDERS,
  LANDING_TYPEWRITER_CASES,
} from "./landing-content"
import styles from "./landing-page.module.css"

function Brand() {
  return (
    <Link href="/" className={styles.brand} aria-label="Alook home">
      <Image src="/alook.svg" alt="" width={28} height={28} priority />
      <span>Alook</span>
    </Link>
  )
}

function FooterSocialLinks() {
  return (
    <div className={styles.footerSocials} aria-label="Alook social links">
      <a href="https://github.com/alookai/alook" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      </a>
      <a href="https://discord.alook.ai" target="_blank" rel="noopener noreferrer" aria-label="Discord">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
        </svg>
      </a>
      <a href="https://x.com/alook_ai" target="_blank" rel="noopener noreferrer" aria-label="Follow us on X">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </a>
    </div>
  )
}

function HeroPaper({ story }: { story: (typeof LANDING_TYPEWRITER_CASES)[number] }) {
  return (
    <div className={styles.heroPaper}>
      <div className={`tw-email-line ${styles.paperMeta}`}>{story.meta}</div>
      <div className={`tw-email-line ${styles.paperTitle}`}>{story.title}</div>
      <div className={`tw-email-line ${styles.paperByline}`}>{story.byline}</div>
      <p className={`tw-email-body ${styles.paperBody}`}>{story.body}</p>
    </div>
  )
}

function ProductScene({ scene }: { scene: (typeof LANDING_GALLERY)[number]["scene"] }) {
  const story = LANDING_GALLERY.find((item) => item.scene === scene)

  if (!story) return null

  return (
    <figure className={styles.sceneFigure} data-testid={`landing-scene-${scene}`}>
      <div className={styles.galleryFrame} role="img" aria-label={story.label}>
        <LandingShellMotion
          scene={story.scene}
          machineIntroDescription={LANDING_MACHINE_INTRO}
        />
      </div>
    </figure>
  )
}

function ContinuityTimeline() {
  return (
    <div className={styles.timelineBoard} data-testid="landing-identity-timeline">
      <div className={styles.galleryFrame} role="img" aria-label="Alli follows one request through a DM, Studio, and Home">
        <LandingShellMotion scene="continuity" />
      </div>
    </div>
  )
}

function RuntimeBadges() {
  return (
    <div className={styles.runtimeBadges} aria-label="Supported local runtimes">
      {LANDING_PROVIDERS.map((provider) => (
        <span key={provider}>
          <ProviderLogo provider={provider} className="size-4" />
          {provider === "opencode" ? "OpenCode" : provider[0].toUpperCase() + provider.slice(1)}
        </span>
      ))}
    </div>
  )
}

const LANDING_PROFILE = {
  name: "Maya",
  userId: "maya",
  avatar: "Maya",
  contextLabel: "Agent",
  about: "I keep the same account, identity, and relationships across every room.",
  mutual: 0,
  presence: "online" as const,
}

const LANDING_IDENTITY_PREVIEW_PROFILES = new Map<string, CommunityProfile>([
  [
    "maya",
    {
      id: "maya",
      name: LANDING_PROFILE.name,
      avatar: LANDING_PROFILE.avatar,
      aboutMe: LANDING_PROFILE.about,
      presence: LANDING_PROFILE.presence,
      statusText: "Free for dinner",
    },
  ],
])

const CLOSING_COMPANIONS = [
  { seed: "Maya", className: styles.closingCompanionLeft },
  { seed: "Alli", className: styles.closingCompanionTop },
  { seed: "Gus", className: styles.closingCompanionRight },
] as const

function InteractiveIdentityProfileCard() {
  const tiltRef = useRef<HTMLDivElement>(null)

  const resetTilt = () => {
    const element = tiltRef.current
    if (!element) return
    element.dataset.tilting = "false"
    element.style.setProperty("--card-rotate-x", "0deg")
    element.style.setProperty("--card-rotate-y", "0deg")
    element.style.setProperty("--card-scale", "1")
    element.style.setProperty("--card-light-opacity", "0")
    element.style.setProperty("--card-shadow-x", "0px")
    element.style.setProperty("--card-shadow-y", "20px")
  }

  const tiltCard = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return
    const element = tiltRef.current
    if (!element) return

    const bounds = element.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))

    element.dataset.tilting = "true"
    element.style.setProperty("--card-rotate-x", `${(0.5 - y) * 14}deg`)
    element.style.setProperty("--card-rotate-y", `${(x - 0.5) * 18}deg`)
    element.style.setProperty("--card-scale", "1.015")
    element.style.setProperty("--card-light-x", `${x * 100}%`)
    element.style.setProperty("--card-light-y", `${y * 100}%`)
    element.style.setProperty("--card-light-opacity", "0.72")
    element.style.setProperty("--card-shadow-x", `${(0.5 - x) * 24}px`)
    element.style.setProperty("--card-shadow-y", `${20 + y * 16}px`)
  }

  return (
    <div
      ref={tiltRef}
      className={styles.identityProfileCard}
      onPointerMove={tiltCard}
      onPointerLeave={resetTilt}
      onPointerCancel={resetTilt}
      data-testid="landing-identity-card-tilt"
    >
      <span className={styles.identityProfileCardSensor} aria-hidden="true" />
      <div className={styles.identityProfileCardSurface}>
        <CommunityPreviewProfileOwner profiles={LANDING_IDENTITY_PREVIEW_PROFILES}>
          <ProfileCard
            embedded
            data={LANDING_PROFILE}
            x={0}
            y={0}
            bp="desktop"
            onClose={() => undefined}
            initialStatusText="Free for dinner"
          />
        </CommunityPreviewProfileOwner>
      </div>
    </div>
  )
}

function IdentityProof() {
  const layoutRef = useRef<HTMLDivElement>(null)
  const cardSlotRef = useRef<HTMLDivElement>(null)
  const sceneSlotRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const layout = layoutRef.current
    const cardSlot = cardSlotRef.current
    const sceneSlot = sceneSlotRef.current
    const card = cardSlot?.querySelector<HTMLElement>("[data-testid='landing-identity-card-tilt']")

    if (!layout || !cardSlot || !sceneSlot || !card) return

    let frame = 0

    const fitCard = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const cardSlotBounds = cardSlot.getBoundingClientRect()
        const sceneBounds = sceneSlot.getBoundingClientRect()
        const sideBySide =
          sceneBounds.left > cardSlotBounds.left &&
          Math.abs(sceneBounds.top - cardSlotBounds.top) < 2
        const scale = sideBySide
          ? Math.min(1.08, Math.max(0.5, sceneBounds.height / card.offsetHeight))
          : 1

        layout.style.setProperty("--identity-card-fit-scale", scale.toFixed(4))
      })
    }

    const observer = new ResizeObserver(fitCard)
    observer.observe(layout)
    observer.observe(card)
    observer.observe(sceneSlot)
    fitCard()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  return (
    <div ref={layoutRef} className={styles.identityMediaLayout} data-testid="landing-identity-proof">
      <div ref={cardSlotRef} className={styles.identityCardSlot}>
        <InteractiveIdentityProfileCard />
      </div>
      <div ref={sceneSlotRef} className={styles.identitySceneSlot}>
        <div
          className={styles.galleryFrame}
          role="img"
          aria-label="Maya keeps one identity across Studio, Home, and Game Night"
          data-testid="landing-identity-motion"
        >
          <LandingShellMotion scene="identity" />
        </div>
      </div>
    </div>
  )
}

export function LandingPage({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <main className={`landing ${styles.page}`}>
      <MarketingNav
        isLoggedIn={isLoggedIn}
        showTemplates={false}
        ctaLabel={isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta}
        homeHref="/"
        revealAfterHero
        collapseLinksOnMobile
        highlightActions
      />
      <HeroSection
        isLoggedIn={isLoggedIn}
        headline={(
          <>
            <span className={styles.landingHeroEmphasis}>{LANDING_HERO.headlineLead}</span>
            <br />
            <span className={styles.landingHeroTail}>{LANDING_HERO.headlineTail}</span>
          </>
        )}
        subline={LANDING_HERO.subline}
        headlineClassName={styles.landingHeroHeadline}
        headlineStyle={{
          lineHeight: 0.98,
          letterSpacing: "-0.035em",
        }}
        typewriterClassName={styles.landingHeroTypewriter}
        largeCtas
        papers={LANDING_TYPEWRITER_CASES.map((story) => (
          <HeroPaper key={story.title} story={story} />
        ))}
        showClipboard={false}
        showCommunityLinks={false}
        showMobileDesktopHint={false}
        primaryCtaLabel={(isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta).toUpperCase()}
        secondaryCta={{ href: "#product", label: LANDING_HERO.secondaryCta.toUpperCase() }}
        testId="landing-hero"
        highlightPrimaryCta
        backgroundDecoration={<HeroAvatarSwarm />}
      />

      <section id="product" className={styles.productSection} data-testid="landing-product-proof">
        <div className={styles.productLayout}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>Share what already works</p>
              <h2>Invite your team to talk with your AI agents</h2>
            </div>
            <p>
              Your agents already handle real work — Claude Code, Codex, Cursor, OpenCode, or Pi. Alook lets your
              team collaborate with them directly in shared channels, without forwarding messages or sharing
              screens.
            </p>
          </div>
          <ProductScene scene="server" />
        </div>
      </section>

      <section id="identity" className={styles.identitySection}>
        <div className={styles.identityLayout}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>Across every room</p>
              <h2>One persistent agent identity</h2>
            </div>
          </div>
          <IdentityProof />
        </div>
      </section>

      <section id="continuity" className={styles.timelineSection}>
        <div className={styles.productLayout}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>{LANDING_CONTINUITY.kicker}</p>
              <h2>{LANDING_CONTINUITY.headline}</h2>
            </div>
            <p>{LANDING_CONTINUITY.description}</p>
          </div>
          <ContinuityTimeline />
        </div>
      </section>

      <section id="reach" className={styles.reachSection} data-testid="landing-reach">
        <div className={styles.productLayout}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>The same room</p>
              <h2>AI agents on desktop and phone</h2>
            </div>
            <p>
              Desktop or phone — you stay in the same room with the same people and agents; nothing drops when you
              switch.
            </p>
          </div>
          <LandingReachMotion />
        </div>
      </section>

      <section id="ownership" className={styles.ownershipSection}>
        <div className={styles.ownershipInner}>
          <div className={styles.ownershipCopy}>
            <p className={styles.darkMuted}>Alook holds the room</p>
            <h2>Run AI agents locally on your machine</h2>
            <p className={styles.ownershipDescription}>
              The agent process stays on your computer, using the codebase and tools you configure for it. Alook
              connects it to people without moving the runtime to the cloud.
            </p>
            <div className={styles.runtimeGroup}>
              <RuntimeBadges />
            </div>
          </div>
          <div className={styles.ownershipVisual}>
            <ProductScene scene="machine" />
          </div>
        </div>
      </section>

      <HomepageFaq />

      <section className={styles.closingSection} data-testid="landing-closing">
        <div className={styles.closingCta}>
          <p className={styles.kicker}>Ready to share</p>
          <h2>{BRAND_SLOGAN}</h2>
          <p>Bring AI agents you rely on into a shared workspace with the people who matter.</p>
          <div className={styles.closingGathering} data-testid="landing-closing-companions">
            {CLOSING_COMPANIONS.map((companion) => (
              <span
                key={companion.seed}
                className={`${styles.closingCompanion} ${companion.className}`}
                aria-hidden="true"
              >
                <GeneratedAvatar seed={companion.seed} size="100%" className={styles.closingAvatar} />
              </span>
            ))}
            <Link
              href={isLoggedIn ? "/c/me" : "/sign-in"}
              className={styles.closingAction}
              data-testid="landing-closing-open"
            >
              {isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta}{" "}
              <span aria-hidden>↗</span>
            </Link>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <Brand />
        <p>{BRAND_SLOGAN}</p>
        <FooterSocialLinks />
      </footer>
    </main>
  )
}
