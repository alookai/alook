"use client"

import { useEffect } from "react"
import { trackSignInSuccess } from "@/lib/analytics"

export function SigninTracker() {
  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )is_sign_in=([^;]*)/)
    if (!match) return
    const method = decodeURIComponent(match[1])
    trackSignInSuccess(method)
    document.cookie = "is_sign_in=; max-age=0; path=/"
  }, [])

  return null
}
