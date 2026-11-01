"use client"

import Image from "next/image"
import { useCallback, useState } from "react"
import { LANDING_HUMAN_AVATARS } from "./landing-human-avatars"
import { GeneratedAvatar } from "@/components/avatar"
import { HeroSection } from "./hero-section"
import { HeroAvatarSwarm } from "./hero-avatar-swarm"
import { HomepageFaq } from "./homepage-faq"
import { LandingTestimonials } from "./landing-testimonials"
import { LandingFeatureGallery } from "./landing-feature-gallery"
import { MarketingNav } from "./marketing-nav"
import { LandingInteractiveDemo } from "./landing-interactive-demo"
import { LandingFooter } from "./landing-footer"
import { LANDING_HERO } from "./landing-content"
import styles from "./landing-page.module.css"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { tid } from "@/lib/community/testids"

const CLOSING_COMPANIONS = [
  { seed: "Maya", className: styles.closingCompanionLeft },
  { seed: "Alli", className: styles.closingCompanionTop },
  { seed: "Gus", className: styles.closingCompanionRight },
] as const

export function LandingPage({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [heroReady, setHeroReady] = useState(false)
  const handleHeroReady = useCallback(() => setHeroReady(true), [])
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
        onReady={handleHeroReady}
        staticPaper
        desktopSplit
        nextSectionId="testimonials"
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
        showCommunityLinks={false}
        showMobileDesktopHint={false}
        primaryCtaLabel={(isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta).toUpperCase()}
        secondaryCta={{ kind: "github", label: LANDING_HERO.secondaryCta }}
        testId="landing-hero"
        highlightPrimaryCta
        backgroundDecoration={<HeroAvatarSwarm />}
      />

      <LandingTestimonials />

      <LandingInteractiveDemo heroReady={heroReady} />

      <LandingFeatureGallery isLoggedIn={isLoggedIn} />

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
            <a
              href={isLoggedIn ? "/c/me" : "/sign-in"}
              className={styles.closingAction}
              data-testid="landing-closing-open"
              onClick={() => trackLandingCtaClicked({ cta_name: isLoggedIn ? "closing_open_app" : "closing_get_started" })}
            >
              {isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta}{" "}
              <span aria-hidden>↗</span>
            </a>
          </div>
        </div>
      </section>

      <LandingFooter />
    </main>
  )
}
