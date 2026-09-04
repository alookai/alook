"use client"

import { useEffect } from "react"
import { trackSignUp } from "@/lib/analytics"
import { queueCommunityOnboarding } from "@/lib/community-onboarding"

export function SignupTracker({ redirectTo }: { redirectTo?: string } = {}) {
  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )is_new_signup=([^;]*)/)
    if (!match) return
    const method = decodeURIComponent(match[1])
    trackSignUp(method)
    document.cookie = "is_new_signup=; max-age=0; path=/"
    if (redirectTo) {
      if (redirectTo.startsWith("/c/")) queueCommunityOnboarding()
      window.location.replace(redirectTo)
    }
  }, [redirectTo])

  return null
}
