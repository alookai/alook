"use client"

import { buttonVariants } from "@/components/ui/button"
import { HandAccent } from "@/components/brand/hand-accent"
import { PaperSticker } from "@/components/brand/paper-sticker"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { DocumentNavigationLink } from "./document-navigation-link"
import { LANDING_VALUES, type LandingValue } from "./landing-content"
import styles from "./landing-value-sections.module.css"

const STICKER_TINTS = ["#f2e6cc", "#d9e6f7", "#e5eec8"] as const
const STICKER_TILTS = [2.2, -1.8, 1.6] as const

function Title({ value }: { value: LandingValue }) {
  const at = value.title.lastIndexOf(value.accent)
  if (at < 0) return <h2>{value.title}</h2>
  return <h2>{value.title.slice(0, at)}<HandAccent>{value.accent}</HandAccent>{value.title.slice(at + value.accent.length)}</h2>
}

export function LandingValueSections({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <section id="value" className={styles.section} aria-label="Why Alook" data-testid="landing-value">
      {LANDING_VALUES.map((value, index) => (
        <article key={value.id} className={styles.row} data-testid={`landing-value-${value.id}`} data-landing-scroll-anchor data-landing-scroll-unit>
          <div className={styles.copy}>
            <Title value={value} />
            <p className={styles.description}>{value.description}</p>
            <ul className={styles.bullets}>
              {value.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
            <DocumentNavigationLink href={isLoggedIn ? "/c/me" : "/sign-in"} data-variant="default" className={cn(buttonVariants({ size: "lg" }), "mt-8")}
              data-testid={tid.landingSectionCta(value.id)}
              onClick={() => trackLandingCtaClicked({ cta_name: `value_${value.id}_${isLoggedIn ? "open_app" : "get_started"}` })}>{value.cta}</DocumentNavigationLink>
          </div>
          <PaperSticker className={styles.art} tilt={STICKER_TILTS[index % STICKER_TILTS.length]} tint={STICKER_TINTS[index % STICKER_TINTS.length]}>
            <img src={value.image.src} alt={value.image.alt} width={1120} height={800} loading="lazy" decoding="async" />
          </PaperSticker>
        </article>
      ))}
    </section>
  )
}
