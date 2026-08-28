"use client"

import { useEffect, useRef, useState, type AnimationEvent, type RefObject } from "react"
import { GeneratedAvatar } from "@/components/avatar"
import { tid } from "@/lib/community/testids"

const REDUCED_MOTION_MS = 140

type AnimationFrameScheduler = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">

export function scheduleAfterStablePaint(
  callback: () => void,
  scheduler: AnimationFrameScheduler = window,
) {
  let secondFrame: number | null = null
  const firstFrame = scheduler.requestAnimationFrame(() => {
    secondFrame = scheduler.requestAnimationFrame(callback)
  })

  return () => {
    scheduler.cancelAnimationFrame(firstFrame)
    if (secondFrame !== null) scheduler.cancelAnimationFrame(secondFrame)
  }
}

type Rect = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">

export type GuideMotionGeometry = {
  startX: number
  startY: number
  controlX: number
  controlY: number
  control2X?: number
  control2Y?: number
  endX: number
  endY: number
  endScale: number
  clearanceScale: number
}

export function guideMotionGeometry(
  stage: Rect,
  landing: Rect,
  avatarSize: number,
  source?: Rect,
): GuideMotionGeometry {
  const sourceGap = 16
  const sideInset = Math.min(96, Math.max(24, stage.width * 0.08))
  const bottomInset = Math.min(64, Math.max(24, stage.height * 0.1))
  const startX = source
    ? Math.min(stage.right - avatarSize - sourceGap, source.right + sourceGap)
    : stage.left + sideInset
  const startY = source
    ? Math.min(
        stage.bottom - avatarSize - sourceGap,
        Math.max(sourceGap, source.top),
      )
    : stage.bottom - avatarSize - bottomInset
  const endX = landing.left
  const endY = landing.top
  const distanceX = endX - startX
  const distanceY = endY - startY
  const arcLift = Math.min(180, Math.max(72, Math.abs(distanceX) * 0.28))
  const mobile = avatarSize < 128

  return {
    startX,
    startY,
    controlX: mobile ? startX + distanceX * 0.7 : startX + distanceX * 0.52,
    controlY: source
      ? startY + distanceY * (mobile ? 0.25 : 0.12)
      : mobile
        ? startY + distanceY * 0.26
        : Math.min(startY, endY) - arcLift,
    control2X: mobile ? startX + distanceX * 0.88 : undefined,
    control2Y: mobile
      ? startY + distanceY * (source ? 0.45 : 0.42)
      : undefined,
    endX,
    endY,
    endScale: landing.width / avatarSize,
    clearanceScale: Math.min(1, 32 / avatarSize),
  }
}

function visibleGuideSource(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    `[data-testid="${tid.machineGuideIntroSource}"]`,
  )
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect()
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    ) {
      return candidate
    }
  }
  return null
}

export function guideMotionPath(geometry: GuideMotionGeometry): string {
  if (geometry.control2X !== undefined && geometry.control2Y !== undefined) {
    return `path("M ${geometry.startX} ${geometry.startY} C ${geometry.controlX} ${geometry.controlY}, ${geometry.control2X} ${geometry.control2Y}, ${geometry.endX} ${geometry.endY}")`
  }
  return `path("M ${geometry.startX} ${geometry.startY} Q ${geometry.controlX} ${geometry.controlY}, ${geometry.endX} ${geometry.endY}")`
}

export function GuideMeAvatarMotion({
  seed,
  intro,
  stageRef,
  onIntroComplete,
}: {
  seed: string
  intro: boolean
  stageRef: RefObject<HTMLElement | null>
  onIntroComplete: () => void
}) {
  const introRef = useRef<HTMLSpanElement>(null)
  const landingRef = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!intro) {
      setReady(false)
      return
    }
    const stage = stageRef.current
    const avatar = introRef.current
    const landing = landingRef.current
    if (!stage || !avatar || !landing) return

    let reducedTimer: number | undefined
    const cancelStablePaint = scheduleAfterStablePaint(() => {
      const avatarSize = avatar.getBoundingClientRect().width
      const source = visibleGuideSource()
      const geometry = guideMotionGeometry(
        stage.getBoundingClientRect(),
        landing.getBoundingClientRect(),
        avatarSize,
        source?.getBoundingClientRect(),
      )
      avatar.style.offsetPath = guideMotionPath(geometry)
      avatar.style.setProperty("--guide-end-scale", String(geometry.endScale))
      avatar.style.setProperty("--guide-clearance-scale", String(geometry.clearanceScale))

      setReady(true)
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reducedTimer = window.setTimeout(onIntroComplete, REDUCED_MOTION_MS)
      }
    })

    return () => {
      cancelStablePaint()
      if (reducedTimer !== undefined) window.clearTimeout(reducedTimer)
    }
  }, [intro, onIntroComplete, stageRef])

  const handleAnimationEnd = (event: AnimationEvent<HTMLSpanElement>) => {
    if (
      event.target === event.currentTarget &&
      event.animationName === "community-first-signup-guide-travel"
    ) {
      onIntroComplete()
    }
  }

  return (
    <>
      <span
        className={`community-guide-me-orbit-holder${intro ? " is-intro" : ""}${ready ? " is-ready" : ""}`}
        aria-hidden="true"
      >
        <span className="community-guide-me-orbit">
          <span
            ref={landingRef}
            className="community-guide-me-avatar"
            data-testid={tid.machineGuideAvatarTarget}
          >
            <GeneratedAvatar
              seed={seed}
              size={24}
              className="rounded-full ring-2 ring-background shadow-sm"
            />
          </span>
        </span>
      </span>
      {intro ? (
        <span
          ref={introRef}
          className={`community-first-signup-guide${ready ? " is-ready" : ""}`}
          data-testid={tid.machineFirstSignupGuide}
          aria-hidden="true"
          onAnimationEnd={handleAnimationEnd}
        >
          <span className="community-first-signup-guide-scale">
            <span className="community-first-signup-guide-art">
              <GeneratedAvatar
                seed={seed}
                size="100%"
                motionParts
                className="rounded-full ring-2 ring-background shadow-lg"
              />
            </span>
          </span>
        </span>
      ) : null}
    </>
  )
}
