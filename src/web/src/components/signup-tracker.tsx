"use client"

import { useEffect } from "react"
import { trackSignUp } from "@/lib/analytics"

export function SignupTracker() {
  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )is_new_signup=([^;]*)/)
    if (!match) return
    const method = decodeURIComponent(match[1])
    trackSignUp(method)
    document.cookie = "is_new_signup=; max-age=0; path=/"
  }, [])

  return null
}
