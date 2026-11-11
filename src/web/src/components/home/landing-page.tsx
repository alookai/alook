"use client"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { DocumentNavigationLink } from "./document-navigation-link"

import Image from "next/image"
import { useCallback, useRef, useState } from "react"
import { LANDING_HUMAN_AVATARS } from "./landing-human-avatars"
import { GeneratedAvatar } from "@/components/avatar"
import { HeroSection } from "./hero-section"
import { PaperFlurry } from "./landing-sky"
import { HomepageFaq } from "./homepage-faq"
import { LandingTestimonials } from "./landing-testimonials"
import { LandingFeatureGallery } from "./landing-feature-gallery"
import { MarketingNav } from "./marketing-nav"
import { LandingInteractiveDemo } from "./landing-interactive-demo"
import { LandingValueSections } from "./landing-value-sections"
import { LandingFooter } from "./landing-footer"
import { LANDING_HERO } from "./landing-content"
import { HandAccent } from "@/components/brand/hand-accent"
import { ThemeToggle } from "@/components/theme-toggle"
import { LandingClosingCollage } from "./landing-closing-collage"
import styles from "./landing-page.module.css"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { tid } from "@/lib/community/testids"
import { useLandingScrollSnap } from "./use-landing-scroll-snap"

const CLOSING_COMPANIONS = [
  { seed: "Maya", className: styles.closingCompanionLeft },
  { seed: "Alli", className: styles.closingCompanionTop },
  { seed: "Gus", className: styles.closingCompanionRight },
] as const

export function LandingPage({ isLoggedIn }: { isLoggedIn: boolean }) {
  const page = useRef<HTMLElement>(null)
  useLandingScrollSnap(page)
  const [heroReady, setHeroReady] = useState(false)
  const handleHeroReady = useCallback(() => setHeroReady(true), [])
  return (
    <main ref={page} className={`landing ${styles.page}`}>
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
            <span className={styles.landingHeroLead}>{LANDING_HERO.headlineLead}</span>
            <br />
            <span className={styles.landingHeroTail}>
              {LANDING_HERO.headlineTail.replace(LANDING_HERO.headlineAccent, "")}
              <HandAccent className={styles.landingHeroAccent}>{LANDING_HERO.headlineAccent}</HandAccent>
            </span>
          </>
        )}
        subline={LANDING_HERO.subline}
        headlineClassName={styles.landingHeroHeadline}
        headlineStyle={{
          lineHeight: 0.98,
          letterSpacing: "-0.035em",
        }}
        typewriterClassName={styles.landingHeroTypewriter}
        typewriterInteraction="hover"
        largeCtas
        showCommunityLinks={false}
        showMobileDesktopHint={false}
        primaryCtaLabel={isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta}
        secondaryCta={{ kind: "github", label: LANDING_HERO.secondaryCta }}
        testId="landing-hero"
        highlightPrimaryCta
        artworkDecoration={<PaperFlurry />}
      />

      {/* Light/dark switch pinned to the hero's bottom-left (Gus #2470). */}
      <div className={styles.heroThemeToggle}>
        <ThemeToggle />
      </div>

      <LandingTestimonials />

      <LandingInteractiveDemo heroReady={heroReady} />

      <LandingValueSections isLoggedIn={isLoggedIn} />

      <LandingFeatureGallery isLoggedIn={isLoggedIn} />

      <HomepageFaq />

      <section className={styles.closingSection} data-testid="landing-closing">
        <div data-slot="landing-closing" className={styles.closingCta} data-landing-scroll-anchor>
          <div className={styles.closingCopy}>
          <p className={styles.kicker}>Ready to share</p>
          <h2>Bring your team into the <HandAccent>conversation</HandAccent></h2>
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
            <DocumentNavigationLink
              href={isLoggedIn ? "/c/me" : "/sign-in"}
              data-variant="default"
              className={cn(buttonVariants({ size: "lg" }), "relative z-2 h-12 min-w-56 px-8 text-base")}
              data-testid="landing-closing-open"
              onClick={() => trackLandingCtaClicked({ cta_name: isLoggedIn ? "closing_open_app" : "closing_get_started" })}
            >
              {isLoggedIn ? LANDING_HERO.loggedInCta : LANDING_HERO.loggedOutCta}{" "}
              <span aria-hidden>↗</span>
            </DocumentNavigationLink>
          </div>
          </div>
          {/* Cut-paper collage around the card (Gus #2408, #2412): the brand's retro objects. */}
          <LandingClosingCollage />
        </div>
      </section>

      <LandingFooter />
    </main>
  )
}
