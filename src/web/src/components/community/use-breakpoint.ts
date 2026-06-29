"use client"

import { useEffect, useState } from "react"
import type { Breakpoint } from "./_types"

// Two stages: mobile ≤600, desktop ≥601.
// Pure mapping from matchMedia results to a Breakpoint — exported for testing.
export function resolveBreakpoint(matches: { mobile: boolean }): Breakpoint {
  return matches.mobile ? "mobile" : "desktop"
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("desktop")
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 600px)")
    const compute = () => setBp(resolveBreakpoint({ mobile: mobile.matches }))
    compute()
    mobile.addEventListener("change", compute)
    return () => mobile.removeEventListener("change", compute)
  }, [])
  return bp
}
