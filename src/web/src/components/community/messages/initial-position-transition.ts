"use client"

import { useMemo } from "react";
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect, useLayoutEffect, useRef } from "react"

export const INITIAL_POSITION_CROSSFADE_MS = 300

export type InitialPositionPhase =
  | "skeleton"
  | "positioning"
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
  const [phase, setPhase] = useAtom(useCreateAtom<InitialPositionPhase>(useMemo<InitialPositionPhase>(() => (
    !firstWindowReady ? "skeleton" : initiallyRevealed ? "revealed" : "positioning"
  ), [firstWindowReady, initiallyRevealed])))
  const revealedRef = useRef(initiallyRevealed)

  useLayoutEffect(() => {
    if (revealedRef.current) return
    if (!firstWindowReady) {
      setPhase("skeleton")
      return
    }
    if (authoritativeEmpty) {
      revealedRef.current = true
      setPhase("revealed")
      return
    }
    if (positionSettled) {
      revealedRef.current = true
      setPhase("revealing")
      return
    }
    if (phase === "skeleton") setPhase("positioning")
  }, [authoritativeEmpty, firstWindowReady, phase, positionSettled, setPhase])

  useEffect(() => {
    if (phase === "revealing") {
      const crossfadeTimer = window.setTimeout(
        () => setPhase("revealed"),
        INITIAL_POSITION_CROSSFADE_MS,
      )
      return () => window.clearTimeout(crossfadeTimer)
    }
  }, [phase, setPhase])

  // The first renderable window must mount its real DOM in the same commit
  // that clears loading. Waiting for the layout effect above to persist the
  // phase would leave the skeleton branch mounted for that commit, so the
  // controller's one-shot hero measurement effect would observe no node and
  // initial anchoring would never arm. This projection changes presentation
  // only; settlement still comes exclusively from the action-owned callback.
  const renderedPhase = !firstWindowReady ? "skeleton" : phase === "skeleton"
    ? authoritativeEmpty || positionSettled ? "revealed" : "positioning"
    : phase

  return {
    phase: renderedPhase,
    showSkeleton: renderedPhase === "skeleton",
    contentVisible: (authoritativeEmpty || positionSettled)
      && (renderedPhase === "revealing" || renderedPhase === "revealed"),
    contentInteractive: (authoritativeEmpty || positionSettled)
      && (renderedPhase === "revealing" || renderedPhase === "revealed"),
  }
}
