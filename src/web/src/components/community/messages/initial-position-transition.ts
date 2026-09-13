"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"

export const INITIAL_POSITION_EFFECT_DELAY_MS = 800
export const INITIAL_POSITION_MINIMUM_EFFECT_MS = 300
export const INITIAL_POSITION_CROSSFADE_MS = 300
export const INITIAL_POSITION_TIMEOUT_MS = 2_000

export type InitialPositionPhase =
  | "skeleton"
  | "positioning"
  | "aurora"
  | "revealing"
  | "revealed"

export function useInitialPositionTransition({
  firstWindowReady,
  authoritativeEmpty,
  positionSettled,
}: {
  firstWindowReady: boolean
  authoritativeEmpty: boolean
  positionSettled: boolean
}) {
  const initiallyRevealed = firstWindowReady && (authoritativeEmpty || positionSettled)
  const [phase, setPhase] = useState<InitialPositionPhase>(() => (
    !firstWindowReady ? "skeleton" : initiallyRevealed ? "revealed" : "positioning"
  ))
  const revealedRef = useRef(initiallyRevealed)
  const startedAtRef = useRef<number | null>(null)
  const auroraStartedAtRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (revealedRef.current) return
    if (!firstWindowReady) {
      startedAtRef.current = null
      auroraStartedAtRef.current = null
      setPhase("skeleton")
      return
    }
    if (authoritativeEmpty || (positionSettled && phase !== "aurora")) {
      revealedRef.current = true
      setPhase("revealed")
      return
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now()
    if (phase === "skeleton") setPhase("positioning")
  }, [authoritativeEmpty, firstWindowReady, phase, positionSettled])

  useEffect(() => {
    if (phase === "revealing") {
      const crossfadeTimer = window.setTimeout(
        () => setPhase("revealed"),
        INITIAL_POSITION_CROSSFADE_MS,
      )
      return () => window.clearTimeout(crossfadeTimer)
    }
    if (revealedRef.current || !firstWindowReady || authoritativeEmpty) return

    const startedAt = startedAtRef.current ?? Date.now()
    startedAtRef.current = startedAt
    const timeoutRemaining = Math.max(
      0,
      INITIAL_POSITION_TIMEOUT_MS - (Date.now() - startedAt),
    )
    const timeoutTimer = window.setTimeout(() => {
      if (revealedRef.current) return
      revealedRef.current = true
      setPhase("revealing")
    }, timeoutRemaining)

    if (phase === "positioning") {
      const delayRemaining = Math.max(
        0,
        INITIAL_POSITION_EFFECT_DELAY_MS - (Date.now() - startedAt),
      )
      const auroraTimer = window.setTimeout(() => {
        if (revealedRef.current || positionSettled) return
        auroraStartedAtRef.current = Date.now()
        setPhase("aurora")
      }, delayRemaining)
      return () => {
        window.clearTimeout(auroraTimer)
        window.clearTimeout(timeoutTimer)
      }
    }

    if (phase === "aurora" && positionSettled) {
      const auroraStartedAt = auroraStartedAtRef.current ?? Date.now()
      auroraStartedAtRef.current = auroraStartedAt
      const minimumRemaining = Math.max(
        0,
        INITIAL_POSITION_MINIMUM_EFFECT_MS - (Date.now() - auroraStartedAt),
      )
      const minimumTimer = window.setTimeout(() => {
        if (revealedRef.current) return
        revealedRef.current = true
        setPhase("revealing")
      }, minimumRemaining)
      return () => {
        window.clearTimeout(minimumTimer)
        window.clearTimeout(timeoutTimer)
      }
    }

    return () => window.clearTimeout(timeoutTimer)
  }, [authoritativeEmpty, firstWindowReady, phase, positionSettled])

  // The first renderable window must mount its real DOM in the same commit
  // that clears loading. Waiting for the layout effect above to persist the
  // phase would leave the skeleton branch mounted for that commit, so the
  // controller's one-shot hero measurement effect would observe no node and
  // initial anchoring would never arm. This projection changes presentation
  // only; settlement still comes exclusively from the action-owned callback.
  const renderedPhase = phase === "skeleton" && firstWindowReady
    ? authoritativeEmpty || positionSettled ? "revealed" : "positioning"
    : phase

  return {
    phase: renderedPhase,
    showSkeleton: renderedPhase === "skeleton",
    contentVisible: renderedPhase === "revealing" || renderedPhase === "revealed",
    contentInteractive: renderedPhase === "revealing" || renderedPhase === "revealed",
    auroraVisible: renderedPhase === "aurora" || renderedPhase === "revealing",
  }
}
