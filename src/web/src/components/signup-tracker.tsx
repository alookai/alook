"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { trackSignUp } from "@/lib/analytics"
import { startCommunityOnboarding } from "@/lib/community-onboarding"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"

export function SignupTracker({ redirectTo }: { redirectTo?: string } = {}) {
  const router = useRouter()
  const breakpoint = useBreakpoint()
  const registry = useOptionalCommunityDbRegistry()

  useEffect(() => {
    if (breakpoint === "unknown") return
    const match = document.cookie.match(/(?:^|; )is_new_signup=([^;]*)/)
    if (!match) return
    const method = decodeURIComponent(match[1])
    trackSignUp(method)
    document.cookie = "is_new_signup=; max-age=0; path=/"
    if (breakpoint === "mobile") return
    if (redirectTo) {
      if (redirectTo.startsWith("/c/")) {
        if (!registry?.runtime.lifecycle.get().active) return
        startCommunityOnboarding(registry.runtime)
        router.replace(redirectTo)
        return
      }
      window.location.replace(redirectTo)
    }
  }, [breakpoint, redirectTo, router, registry])

  return null
}
