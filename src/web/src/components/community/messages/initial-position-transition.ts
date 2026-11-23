"use client"

type InitialPositionPhase = "skeleton" | "revealed"

export function useInitialPositionTransition({
  firstWindowReady,
}: {
  firstWindowReady: boolean
  authoritativeEmpty?: boolean
  positionSettled?: boolean
}) {
  const phase: InitialPositionPhase = firstWindowReady ? "revealed" : "skeleton"
  return {
    phase,
    showSkeleton: phase === "skeleton",
    contentVisible: phase === "revealed",
    contentInteractive: phase === "revealed",
  }
}
