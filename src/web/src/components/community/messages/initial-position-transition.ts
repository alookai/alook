"use client"

type InitialPositionPhase = "skeleton" | "positioning" | "revealed"

export function useInitialPositionTransition({
  firstWindowReady,
  authoritativeEmpty,
  positionSettled,
}: {
  firstWindowReady: boolean
  authoritativeEmpty: boolean
  positionSettled: boolean
}) {
  const phase: InitialPositionPhase = !firstWindowReady ? "skeleton"
    : authoritativeEmpty || positionSettled ? "revealed" : "positioning"
  return {
    phase,
    showSkeleton: phase !== "revealed",
    contentVisible: phase === "revealed",
    contentInteractive: phase === "revealed",
  }
}
