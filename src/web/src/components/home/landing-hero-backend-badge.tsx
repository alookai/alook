"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
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
  const trackRef = useRef<HTMLSpanElement | null>(null)
  const currentRef = useRef<HTMLSpanElement | null>(null)
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

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    if (reducedMotion) {
      track.style.width = ""
      return
    }
    const element = currentRef.current
    if (!element) return
    let active = true
    const measure = () => {
      if (!active || !currentRef.current || !trackRef.current) return
      const target = currentRef.current
      const width = Math.max(target.scrollWidth, target.offsetWidth, target.getBoundingClientRect().width)
      if (width > 0) trackRef.current.style.width = `${Math.ceil(width)}px`
    }
    measure()
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener("resize", measure)
    void document.fonts?.ready?.then(measure)
    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [provider.id, reducedMotion])

  return (
    <span className={styles.heroBackendSlot} ref={targetRef}>
      <Badge
        variant="outline"
        className={styles.heroBackendBadge}
        data-testid="landing-hero-backend"
        data-provider={provider.id}
      >
        <span
          ref={trackRef}
          className={styles.heroBackendTrack}
          data-testid="landing-hero-backend-track"
        >
          {(previous ? [previous, provider] : [provider]).map((item) => {
            const leaving = item === previous
            return (
              <span
                key={item.id}
                ref={leaving ? undefined : currentRef}
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
