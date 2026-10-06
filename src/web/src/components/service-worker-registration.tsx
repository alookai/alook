"use client"

import { useEffect } from "react"

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return
    const register = async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    }
    void register().catch(() => {
      console.warn("Public asset service worker registration unavailable")
    })
  }, [])
  return null
}
