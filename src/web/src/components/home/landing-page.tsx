"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"
import { LANDING_HUMAN_AVATARS } from "./landing-human-avatars"
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
import { LandingFooter } from "./landing-footer"
import {
  LANDING_CONTINUITY,
  LANDING_GALLERY,
  LANDING_HERO,
  LANDING_MACHINE_INTRO,
  LANDING_PROVIDERS,
} from "./landing-content"
import styles from "./landing-page.module.css"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { tid } from "@/lib/community/testids"

function SectionCta({ isLoggedIn, section, children }: {
  isLoggedIn: boolean
  section: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={isLoggedIn ? "/c/me" : "/sign-in"}
      className={styles.sectionCta}
      data-testid={`landing-section-cta-${section}`}
      onClick={() => trackLandingCtaClicked({ cta_name: `${section}_${isLoggedIn ? "open_app" : "get_started"}` })}
    >
      {children}
    </Link>
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
    <div
      className={styles.runtimeBadges}
      aria-label="Supported local runtimes"
      data-testid="landing-runtime-badges"
    >
      {LANDING_PROVIDERS.map((provider) => (
        <span key={provider.id}>
          <ProviderLogo provider={provider.id} className="size-4" />
          {provider.label}
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
        containerClassName={styles.siteContainer}
        containerTestId={tid.landingHeaderContainer}
      />
      <HeroSection
        desktopSplit
        nextSectionId="product"
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
        showClipboard={false}
        showCommunityLinks={false}
        showMobileDesktopHint={false}
        primaryCtaLabel={(isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta).toUpperCase()}
        secondaryCta={{ kind: "github", label: LANDING_HERO.secondaryCta }}
        testId="landing-hero"
        highlightPrimaryCta
        backgroundDecoration={<HeroAvatarSwarm />}
      />

      <section id="product" tabIndex={-1} className={styles.productSection} data-testid="landing-product-proof">
        <div className={styles.productLayout} data-testid={tid.landingMainContainer}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>Give feedback together</p>
              <h2>Let teammates talk to your agent.</h2>
            </div>
            <p>
              They can ask for a preview, request a change, and review the result in one conversation.
            </p>
            <SectionCta isLoggedIn={isLoggedIn} section="product">Share your agent</SectionCta>
          </div>
          <ProductScene scene="server" />
        </div>
      </section>

      <section id="identity" className={styles.identitySection}>
        <div className={styles.identityLayout}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>A familiar face</p>
              <h2>Bring a familiar agent along.</h2>
            </div>
            <p>
              Invite Maya into your next project with the same name and profile your team already knows.
            </p>
            <SectionCta isLoggedIn={isLoggedIn} section="identity">Invite your agent</SectionCta>
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
            <SectionCta isLoggedIn={isLoggedIn} section="continuity">Start a task</SectionCta>
          </div>
          <ContinuityTimeline />
        </div>
      </section>

      <section id="reach" className={styles.reachSection} data-testid="landing-reach">
        <div className={styles.productLayout}>
          <div className={styles.sectionIntro}>
            <div className={styles.sectionLead}>
              <p className={styles.sectionMuted}>Away from your desk</p>
              <h2>Check in from your phone.</h2>
            </div>
            <p>
              Read updates and give the next instruction wherever you are. Keep your agent’s computer online.
            </p>
            <SectionCta isLoggedIn={isLoggedIn} section="reach">Work anywhere</SectionCta>
          </div>
          <LandingReachMotion />
        </div>
      </section>

      <section id="ownership" className={styles.ownershipSection}>
        <div className={styles.ownershipInner}>
          <div className={styles.ownershipCopy}>
            <p className={styles.darkMuted}>Use your existing setup</p>
            <h2>Keep your existing setup.</h2>
            <p className={styles.ownershipDescription}>
              Connect the agent you already use. It runs on your computer with your project, tools, and configured access.
            </p>
            <SectionCta isLoggedIn={isLoggedIn} section="ownership">Connect your agent</SectionCta>
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
          <h2>Bring your team into the conversation.</h2>
          <p>Connect your agent and invite a teammate.</p>
          <div className={styles.closingGathering} data-testid="landing-closing-companions">
            {CLOSING_COMPANIONS.map((companion) => (
              <span
                key={companion.seed}
                className={`${styles.closingCompanion} ${companion.className}`}
                aria-hidden="true"
              >
                {companion.seed === "Gus" ? (
                  <Image src={LANDING_HUMAN_AVATARS.gus} alt="" width={58} height={58} className={styles.closingAvatar} />
                ) : (
                  <GeneratedAvatar seed={companion.seed} size="100%" className={styles.closingAvatar} />
                )}
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

      <LandingFooter />
    </main>
  )
}
