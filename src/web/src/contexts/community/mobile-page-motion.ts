"use client"

import { createContext } from "react"

export type MobileEntryMotion = {
  pauseEntry: () => void
  resumeEntry: () => void
  exitEntry: () => Promise<boolean>
  isExiting: () => boolean
  resetExit: () => void
}

export const MobilePageMotionContext = createContext<(MobileEntryMotion & { entryHandled: boolean }) | null>(null)
