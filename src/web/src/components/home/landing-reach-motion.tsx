"use client"

import { useEffect, useState } from "react"
import {
  LandingMobileChatMotion,
  LandingShellMotion,
} from "./landing-shell-motion"
import {
  SCENE_BEAT_DURATION_MS,
  SCENE_FINAL_HOLD_MS,
  SCENE_MAX_BEAT,
} from "./landing-shell-motion-timeline"
import styles from "./landing-reach-motion.module.css"
import { useLandingMotionPlayback } from "./use-landing-motion-playback"

/**
 * Device shell anatomy adapted from OpensourceUI's LaptopMockupCard and
 * PhoneMockupCard. See ./opensourceui-mockups.LICENSE.txt.
 */

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => setReduced(query.matches)
    sync()
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])

  return reduced
}

export function LandingReachMotion() {
  const maxBeat = SCENE_MAX_BEAT.server
  const reducedMotion = useReducedMotion()
  const [beat, setBeat] = useState(0)
  const {
    targetRef: playbackRef,
    isPlaying,
    shouldReset,
  } = useLandingMotionPlayback<HTMLDivElement>()

  useEffect(() => {
    setBeat(reducedMotion ? maxBeat : 0)
  }, [maxBeat, reducedMotion])

  useEffect(() => {
    if (!reducedMotion && shouldReset) setBeat(0)
  }, [reducedMotion, shouldReset])

  useEffect(() => {
    if (reducedMotion || !isPlaying) return
    const delay = beat >= maxBeat ? SCENE_FINAL_HOLD_MS : SCENE_BEAT_DURATION_MS
    const timer = window.setTimeout(() => {
      setBeat((current) => (current >= maxBeat ? 0 : current + 1))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [beat, isPlaying, maxBeat, reducedMotion])

  return (
    <div
      ref={playbackRef}
      className={styles.stage}
      data-testid="landing-reach-motion"
      data-beat={beat}
      aria-label="The same Alook room updating on desktop and mobile"
    >
      <div
        className={styles.desktopShell}
        data-slot="laptop-mockup-card"
        data-variant="starlight"
        data-testid="landing-laptop-mockup"
      >
        <div className={styles.laptopLid}>
          <div className={styles.laptopBezel}>
            <div className={styles.laptopScreen}>
              <LandingShellMotion scene="server" beat={beat} />
            </div>
          </div>
        </div>
        <div className={styles.laptopBase} aria-hidden="true">
          <span className={styles.laptopNotch} />
        </div>
      </div>

      <div
        className={styles.phone}
        data-slot="phone-mockup-card"
        data-variant="titanium"
        data-testid="landing-phone-mockup"
      >
        <span className={styles.phoneMuteButton} aria-hidden="true" />
        <span className={styles.phoneVolumeUpButton} aria-hidden="true" />
        <span className={styles.phoneVolumeDownButton} aria-hidden="true" />
        <span className={styles.phonePowerButton} aria-hidden="true" />
        <div className={styles.phoneBezel}>
          <div className={styles.phoneScreen}>
            <LandingMobileChatMotion beat={beat} />
            <span className={styles.phoneDynamicIsland} aria-hidden="true">
              <span />
            </span>
            <span className={styles.phoneHomeIndicator} aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}
