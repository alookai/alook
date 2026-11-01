"use client"

import { useEffect } from "react"
import { useSelector } from "@tanstack/react-store"
import { businessSchemaLifecycle, rememberBusinessUpdateAttempt, retryBusinessSchemaUpdate } from "@/lib/business-schema-lifecycle"
import { AnimatedAlookLogo } from "@/components/community/shell/animated-alook-logo"
import { Button } from "@/components/ui/button"

export function ServiceWorkerRegistration() {
  const phase = useSelector(businessSchemaLifecycle, state => state.phase)
  useEffect(() => {
    rememberBusinessUpdateAttempt()
    if (!("serviceWorker" in navigator)) return
    const register = async () => {
      if (process.env.NODE_ENV !== "production") return
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    }
    void register().catch(() => {
      console.warn("Public asset service worker registration unavailable")
    })
  }, [])
  if (phase === "current") return null
  return <div className="fixed inset-0 z-100 flex flex-col items-center justify-center gap-4 bg-background p-8 text-foreground" data-testid="business-schema-update" role={phase === "failed" ? "alert" : "status"} aria-busy={phase === "updating"}>
    <AnimatedAlookLogo className="size-16" />
    {phase === "failed" && <><p>Couldn&apos;t update this page.</p><Button variant="outline" onClick={retryBusinessSchemaUpdate}>Retry</Button></>}
  </div>
}
