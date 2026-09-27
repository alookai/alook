"use client"

import { useIsRestoring } from "@tanstack/react-query"
import { useLayoutEffect, useRef, type ReactNode } from "react"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"

export function CommunityRestoreBoundary({ children }: { children: ReactNode }) {
  const isRestoring = useIsRestoring()
  const communityDb = useOptionalCommunityDbRegistry()
  const restoreStarted = useRef(false)

  useLayoutEffect(() => {
    if (isRestoring && !restoreStarted.current) {
      restoreStarted.current = true
      performance.mark("alook:restore:start")
      return
    }
    if (isRestoring || !restoreStarted.current) return
    performance.mark("alook:restore:complete")
    const restoredDataExists = communityDb?.hasRestoredData() === true
    if (restoredDataExists) performance.mark("alook:restore:first-cached-paint")
    const frame = requestAnimationFrame(() => performance.mark("alook:restore:stable"))
    return () => cancelAnimationFrame(frame)
  }, [communityDb, isRestoring])

  // PersistQueryClientProvider keeps network queries paused during restore.
  // Mount route consumers immediately so each region can either paint its
  // trusted cache or reuse its existing local skeleton while data is absent.
  return children
}
