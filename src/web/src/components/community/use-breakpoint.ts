"use client"

import { useEffect, useState } from "react"
import type { Breakpoint } from "./_types"

// Plan stages: mobile ≤600, tablet 601–960, desktop ≥961.
// Pure mapping from matchMedia results to a Breakpoint — exported for testing.
export function resolveBreakpoint(matches: { mobile: boolean; tablet: boolean }): Breakpoint {
  return matches.mobile ? "mobile" : matches.tablet ? "tablet" : "desktop"
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("desktop")
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 600px)")
    const tablet = window.matchMedia("(min-width: 601px) and (max-width: 960px)")
    const compute = () =>
      setBp(resolveBreakpoint({ mobile: mobile.matches, tablet: tablet.matches }))
    compute()
    mobile.addEventListener("change", compute)
    tablet.addEventListener("change", compute)
    return () => {
      mobile.removeEventListener("change", compute)
      tablet.removeEventListener("change", compute)
    }
  }, [])
  return bp
}
