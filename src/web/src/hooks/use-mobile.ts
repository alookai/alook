"use client"

import { useEffect, useState } from "react"

// Aligned to Tailwind's `sm` breakpoint. See DESIGN.md → Breakpoints.
const MOBILE_BREAKPOINT = 640
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

export type Breakpoint = "unknown" | "desktop" | "mobile"

// Pure mapping from matchMedia results to a Breakpoint — exported for testing.
export function resolveBreakpoint(matches: { mobile: boolean }): Breakpoint {
  return matches.mobile ? "mobile" : "desktop"
}

export function readBreakpoint(): Breakpoint {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "unknown"
  return resolveBreakpoint({ mobile: window.matchMedia(MOBILE_MEDIA_QUERY).matches })
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("unknown")
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    const compute = () => setBp(resolveBreakpoint({ mobile: mql.matches }))
    compute()
    mql.addEventListener("change", compute)
    return () => mql.removeEventListener("change", compute)
  }, [])
  return bp
}

export function useIsMobile(): boolean {
  return useBreakpoint() === "mobile"
}
