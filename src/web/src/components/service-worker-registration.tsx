"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { useSelector } from "@tanstack/react-store"
import { businessSchemaLifecycle, rememberBusinessUpdateAttempt, requestBusinessSchemaUpdate, requestDocumentBuildUpdate, retryBusinessSchemaUpdate } from "@/lib/business-schema-lifecycle"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared/business-schema-version"
import { DOCUMENT_UPDATE_AVAILABLE, WORKER_VERSION_PROBE, isBusinessDocumentPath, isCurrentBusinessDocument, probeBusinessIdentity } from "@/lib/service-worker/business-upgrade"
import { WEB_BUILD_ID } from "@/lib/web-build"
import { listenNativeWindowLifecycle } from "@/lib/native-window-lifecycle"
import { AnimatedAlookLogo } from "@/components/community/shell/animated-alook-logo"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"

export function ServiceWorkerRegistration() {
  const pathname = usePathname()
  const phase = useSelector(businessSchemaLifecycle, state => state.phase)
  useEffect(() => {
    rememberBusinessUpdateAttempt()
    if (!("serviceWorker" in navigator)) return
    let disposed = false
    let cleanup = () => {}
    const register = async () => {
      if (process.env.NODE_ENV !== "production") return
      const container = navigator.serviceWorker
      const registration = await container.register("/sw.js", { scope: "/", updateViaCache: "none" })
      if (disposed) return
      let updating: Promise<unknown> | undefined
      const check = async (refresh: boolean) => {
        if (disposed || document.visibilityState === "hidden") return
        if (refresh) {
          updating ??= registration.update().finally(() => { updating = undefined })
          await updating
        }
        if (disposed || !isCurrentBusinessDocument()) return
        const worker = container.controller ?? registration.active
        const identity = worker ? await probeBusinessIdentity(worker, WORKER_VERSION_PROBE) : null
        if (disposed || !isCurrentBusinessDocument() || worker !== (container.controller ?? registration.active) || !identity) return
        if (identity.schemaVersion !== BUSINESS_SCHEMA_VERSION) requestBusinessSchemaUpdate(identity.schemaVersion)
        else if (identity.buildId && identity.buildId !== WEB_BUILD_ID) requestDocumentBuildUpdate(identity.buildId)
      }
      const resume = () => { void check(true).catch(() => console.warn("Public asset service worker update check unavailable")) }
      const changed = () => { void check(false).catch(() => console.warn("Public asset service worker identity unavailable")) }
      const message = (event: MessageEvent) => {
        if (event.source === container.controller && event.data?.type === DOCUMENT_UPDATE_AVAILABLE) changed()
      }
      container.addEventListener("controllerchange", changed)
      container.addEventListener("message", message)
      window.addEventListener("focus", resume)
      window.addEventListener("pageshow", resume)
      document.addEventListener("visibilitychange", resume)
      const unlisten = listenNativeWindowLifecycle({ resumed: resume, suspended: () => {} })
      cleanup = () => {
        container.removeEventListener("controllerchange", changed)
        container.removeEventListener("message", message)
        window.removeEventListener("focus", resume)
        window.removeEventListener("pageshow", resume)
        document.removeEventListener("visibilitychange", resume)
        unlisten()
      }
      await check(false)
    }
    void register().catch(() => {
      console.warn("Public asset service worker registration unavailable")
    })
    return () => { disposed = true; cleanup() }
  }, [])
  if (phase === "current" || !isCurrentBusinessDocument() || pathname !== null && !isBusinessDocumentPath(pathname)) return null
  return <div className="fixed inset-0 z-100 flex flex-col items-center justify-center gap-4 bg-background p-8 text-foreground" data-testid={tid.businessSchemaUpdate} role={phase === "failed" ? "alert" : "status"} aria-busy={phase === "updating"}>
    <AnimatedAlookLogo className="size-16" />
    {phase === "failed" && <><p>Couldn&apos;t update this page.</p><Button variant="outline" onClick={retryBusinessSchemaUpdate}>Retry</Button></>}
  </div>
}
