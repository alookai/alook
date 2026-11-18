"use client"

import { useEffect } from "react"
import { captureAnalyticsOwner } from "@/lib/analytics-owner"
import { captureProductAnalytics, type ProductAnalyticsInput } from "@/lib/product-analytics"
import { useRouter } from "next/navigation"
import { startCommunityOnboarding } from "@/lib/community-onboarding"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"

export function SignupTracker({ redirectTo }: { redirectTo?: string } = {}) {
  const router = useRouter()
  const registry = useOptionalCommunityDbRegistry()

  useEffect(() => {
    const assertCurrent = registry ? captureAnalyticsOwner(registry.runtime.lifecycle) : undefined
    const track = (input: ProductAnalyticsInput) => assertCurrent ? captureProductAnalytics(input, assertCurrent) : captureProductAnalytics(input)
    const signedIn = document.cookie.match(/(?:^|; )is_sign_in=([^;]*)/)
    if (signedIn) {
      document.cookie = "is_sign_in=; max-age=0; path=/"
      void track({ event: "sign_in_success", method: signedIn[1] })
    }
    const match = document.cookie.match(/(?:^|; )is_new_signup=([^;]*)/)
    if (!match) return
    document.cookie = "is_new_signup=; max-age=0; path=/"
    void track({ event: "sign_up", method: match[1] })
    if (redirectTo) {
      if (redirectTo.startsWith("/c/")) {
        if (!registry?.runtime.lifecycle.get().active) return
        startCommunityOnboarding(registry.runtime)
        router.replace(redirectTo)
        return
      }
      window.location.replace(redirectTo)
    }
  }, [redirectTo, router, registry])

  return null
}
