"use client"

import { lazy, useRef, type PointerEvent as ReactPointerEvent } from "react"
import { RuntimeBadge } from "@/components/community/machines/machine-runtimes"
import { tid } from "@/lib/community/testids"
import { LandingReachMotion } from "./landing-reach-motion"
const LandingShellMotion = lazy(() => import("./landing-shell-motion").then(module => ({ default: module.LandingShellMotion })))
const ProfileCard = lazy(() => import("./landing-profile-content"))
import { LANDING_GALLERY, LANDING_MACHINE_INTRO, LANDING_PROVIDERS } from "./landing-content"
import styles from "./landing-page.module.css"
import galleryStyles from "./landing-feature-gallery.module.css"

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
      className={galleryStyles.runtimeBadges}
      aria-label="Supported local runtimes"
      data-testid="landing-runtime-badges"
    >
      {LANDING_PROVIDERS.map((provider) => <RuntimeBadge key={provider.id} id={provider.id} label={provider.label} />)}
    </div>
  )
}

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
      className={`${styles.identityProfileCard} ${galleryStyles.profileCard}`}
      onPointerMove={tiltCard}
      onPointerLeave={resetTilt}
      onPointerCancel={resetTilt}
      data-testid="landing-identity-card-tilt"
    >
      <div className={styles.identityProfileCardSurface}>
        <ProfileCard />
      </div>
    </div>
  )
}

export default function LandingFeatureScene({ feature }: { feature: string }) {
  if (feature === "identity") return <div className={galleryStyles.identityMedia} data-testid={tid.landingIdentityProof}><InteractiveIdentityProfileCard /></div>
  if (feature === "continuity") return <ContinuityTimeline />
  if (feature === "reach") return <LandingReachMotion />
  if (feature === "ownership") return <><ProductScene scene="machine" /><RuntimeBadges /></>
  return <ProductScene scene="server" />
}
