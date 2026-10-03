"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect } from "react"

// Aligned to Tailwind's `sm` breakpoint. See DESIGN.md → Breakpoints.
const MOBILE_BREAKPOINT = 640

export type Breakpoint = "unknown" | "desktop" | "mobile"

// Pure mapping from matchMedia results to a Breakpoint — exported for testing.
export function resolveBreakpoint(matches: { mobile: boolean }): Breakpoint {
  return matches.mobile ? "mobile" : "desktop"
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useAtom(useCreateAtom<Breakpoint>("unknown"))
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const compute = () => setBp(resolveBreakpoint({ mobile: mql.matches }))
    compute()
    mql.addEventListener("change", compute)
    return () => mql.removeEventListener("change", compute)
  }, [setBp])
  return bp
}

export function useIsMobile(): boolean {
  return useBreakpoint() === "mobile"
}
