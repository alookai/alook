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

  useEffect(() => {
    setBeat(reducedMotion ? maxBeat : 0)
  }, [maxBeat, reducedMotion])

  useEffect(() => {
    if (reducedMotion) return
    const delay = beat >= maxBeat ? SCENE_FINAL_HOLD_MS : SCENE_BEAT_DURATION_MS
    const timer = window.setTimeout(() => {
      setBeat((current) => (current >= maxBeat ? 0 : current + 1))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [beat, maxBeat, reducedMotion])

  return (
    <div
      className={styles.stage}
      data-testid="landing-reach-motion"
      data-beat={beat}
      aria-label="The same Alook room updating on desktop and mobile"
    >
      <div className={styles.desktopShell}>
        <div className={styles.deviceBar} aria-hidden>
          <span />
          <span />
          <span />
          <p>Desktop</p>
        </div>
        <LandingShellMotion scene="server" beat={beat} />
      </div>

      <div className={styles.phone}>
        <LandingMobileChatMotion beat={beat} />
      </div>
    </div>
  )
}
