"use client"

import { useEffect } from "react"
import { cleanupAuthenticatedNativeOauthResidue } from "@/lib/native-oauth-authenticated-cleanup"

export function AuthenticatedNativeOauthCleanup() {
  useEffect(() => {
    void cleanupAuthenticatedNativeOauthResidue().catch(() => {})
  }, [])
  return null
}
