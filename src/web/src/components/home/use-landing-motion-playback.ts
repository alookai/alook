"use client"

import { useEffect, useRef, useState } from "react"

export const LANDING_MOTION_VISIBILITY_THRESHOLD = 0.3

export type LandingMotionVisibility = "hidden" | "paused" | "playing"

export function landingMotionVisibility(
  entry: Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio">,
): LandingMotionVisibility {
  if (!entry.isIntersecting || entry.intersectionRatio <= 0) return "hidden"
  if (entry.intersectionRatio < LANDING_MOTION_VISIBILITY_THRESHOLD) return "paused"
  return "playing"
}

export function shouldPlayLandingMotion(entry: Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio">) {
  return landingMotionVisibility(entry) === "playing"
}

export function useLandingMotionPlayback<T extends Element>() {
  const targetRef = useRef<T>(null)
  const [visibility, setVisibility] = useState<LandingMotionVisibility>("hidden")

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    if (!("IntersectionObserver" in window)) {
      setVisibility("playing")
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => setVisibility(entry ? landingMotionVisibility(entry) : "hidden"),
      { threshold: [0, LANDING_MOTION_VISIBILITY_THRESHOLD] },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  return {
    targetRef,
    visibility,
    isPlaying: visibility === "playing",
    shouldReset: visibility === "hidden",
  }
}
