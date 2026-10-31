"use client"

import { lazy, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"
import { ProviderLogo } from "@/components/provider-logo"
import { LandingReachMotion } from "./landing-reach-motion"
const LandingShellMotion = lazy(() => import("./landing-shell-motion").then(module => ({ default: module.LandingShellMotion })))
const ProfileCard = lazy(() => import("./landing-profile-content"))
import { LANDING_GALLERY, LANDING_MACHINE_INTRO, LANDING_PROVIDERS } from "./landing-content"
import styles from "./landing-page.module.css"

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
        <ProfileCard />
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

export default function LandingFeatureScene({ feature }: { feature: string }) {
  if (feature === "identity") return <IdentityProof />
  if (feature === "continuity") return <ContinuityTimeline />
  if (feature === "reach") return <LandingReachMotion />
  if (feature === "ownership") return <><ProductScene scene="machine" /><RuntimeBadges /></>
  return <ProductScene scene="server" />
}
