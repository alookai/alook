"use client"

import { useEffect, useState } from "react"

// Aligned to Tailwind's `sm` breakpoint. See DESIGN.md → Breakpoints.
const MOBILE_BREAKPOINT = 640

export type Breakpoint = "desktop" | "mobile"

// Pure mapping from matchMedia results to a Breakpoint — exported for testing.
export function resolveBreakpoint(matches: { mobile: boolean }): Breakpoint {
  return matches.mobile ? "mobile" : "desktop"
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("desktop")
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
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
