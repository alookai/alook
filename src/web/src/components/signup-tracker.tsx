"use client"

import { useEffect } from "react"
import { trackSignUp } from "@/lib/analytics"
import { writeFirstSignupGuideHandoff } from "@/lib/community/first-signup-guide"

export function SignupTracker({ redirectTo }: { redirectTo?: string } = {}) {
  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )is_new_signup=([^;]*)/)
    if (!match) return
    const method = decodeURIComponent(match[1])
    trackSignUp(method)
    if (redirectTo) writeFirstSignupGuideHandoff()
    document.cookie = "is_new_signup=; max-age=0; path=/"
    if (redirectTo) window.location.replace(redirectTo)
  }, [redirectTo])

  return null
}
