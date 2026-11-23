"use client"

import { useEffect, useState } from "react"
import { ProviderLogo } from "@/components/provider-logo"
import { Badge } from "@/components/ui/badge"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { cn } from "@/lib/utils"
import { LANDING_PROVIDERS } from "./landing-content"
import { useLandingMotionPlayback } from "./use-landing-motion-playback"
import styles from "./landing-page.module.css"

const PROVIDER_INTERVAL_MS = 3000

export function LandingHeroBackendBadge() {
  const reducedMotion = useReducedMotion()
  const { targetRef, isPlaying } = useLandingMotionPlayback<HTMLSpanElement>()
  const [step, setStep] = useState(0)
  const provider = LANDING_PROVIDERS[reducedMotion ? 0 : step % LANDING_PROVIDERS.length]
  const previous = !reducedMotion && step > 0 ? LANDING_PROVIDERS[(step - 1) % LANDING_PROVIDERS.length] : null

  useEffect(() => {
    if (reducedMotion || !isPlaying) return
    let timer: number | undefined
    const sync = () => {
      window.clearInterval(timer)
      if (document.hidden) return
      timer = window.setInterval(
        () => setStep((current) => current + 1),
        PROVIDER_INTERVAL_MS,
      )
    }
    sync()
    document.addEventListener("visibilitychange", sync)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", sync)
    }
  }, [isPlaying, reducedMotion])

  return (
    <span className={styles.heroBackendSlot} ref={targetRef}>
      <Badge
        variant="outline"
        className={styles.heroBackendBadge}
        data-testid="landing-hero-backend"
        data-provider={provider.id}
      >
        <span className={styles.heroBackendTrack}>
          {(previous ? [previous, provider] : [provider]).map((item) => {
            const leaving = item === previous
            return (
              <span
                key={item.id}
                data-backend-current={!leaving || undefined}
                aria-hidden={leaving || undefined}
                className={cn(styles.heroBackendName, previous && (leaving ? styles.heroBackendOutgoing : styles.heroBackendIncoming))}
              >
                <span className={styles.heroBackendIcon} aria-hidden="true"><ProviderLogo provider={item.id} /></span>
                <span>{item.label}</span>
              </span>
            )
          })}
        </span>
      </Badge>
    </span>
  )
}
