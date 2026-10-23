"use client"

import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useCommunityRouteFrame } from "./community-route-context"
import { MobilePageBackContext } from "@/contexts/community/mobile-page-back"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { requestNativeBack } from "@/components/ui/native-back-layer"
import { hasPendingParentReturn } from "./use-community-navigation-controller"
import { SwipeRoot, SwipePortal, SwipeViewport, SwipePopup } from "@/components/ui/swipe-container"

export function MobilePage({ children, parentPath, active = true, backgroundVisible = true }: {
  children: ReactNode
  parentPath: string
  active?: boolean
  backgroundVisible?: boolean
}) {
  const { breakpoint, navigation, frame } = useCommunityRouteFrame()
  const registry = useContext(MobilePageBackContext)
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const runtime = useCommunityRuntime()
  const [open, setOpen] = useState(breakpoint !== "mobile")
  const pending = useRef<{ parentPath: string; isCurrent: () => boolean } | null>(null)
  const departed = useRef(false)
  const mobile = breakpoint === "mobile"
  const parentReturnPending = hasPendingParentReturn(navigation)
  const request = useCallback((target: string) => {
    if (!active || !mobile || target !== parentPath) return false
    if (pending.current) return true
    if (requestNativeBack(document) !== "none") return false
    const current = navigation.captureIntent(parentReturnPending && navigation.pendingHref
      ? { pendingCommitHref: navigation.pendingHref } : undefined)
    pending.current = { parentPath, isCurrent: () => runtime.lifecycle.get().active && runtime.ws.get().accessEpoch === accessEpoch
      && window.matchMedia("(max-width: 639px)").matches && current() }
    setOpen(false)
    return true
  }, [accessEpoch, active, mobile, navigation, parentPath, parentReturnPending, runtime])
  useLayoutEffect(() => {
    if (mobile && departed.current && (navigation.pendingHref === parentPath || navigation.publishedHref === parentPath)) return
    if (mobile && active && pending.current?.parentPath === parentPath && pending.current.isCurrent()) return
    departed.current = false
    pending.current = null
    setOpen(true)
  }, [mobile, active, frame.revision, navigation.entryIntent, navigation.pendingHref, navigation.publishedHref, accessEpoch, parentPath])
  useLayoutEffect(() => () => { pending.current = null }, [])
  useLayoutEffect(() => {
    if (!mobile || !active) return
    return registry?.register(request)
  }, [active, mobile, registry, request])
  return <div inert={!active} aria-hidden={!active || undefined} data-mobile-page-active={active}
    hidden={!active && (!mobile || !backgroundVisible)} className="flex min-h-0 min-w-0 flex-1 flex-col max-sm:absolute max-sm:inset-0">
    <SwipeRoot kind="page" open={open} swipeEnabled={mobile && active && (!navigation.navigationPending || parentReturnPending)}
      onOpenChange={(next, details) => {
        if (next) return
        if (details.reason !== "swipe" || !request(parentPath)) details.cancel()
      }}
      onOpenChangeComplete={(next) => {
        if (next) return
        const valid = pending.current
        pending.current = null
        if (valid?.parentPath === parentPath && valid.isCurrent()) {
          departed.current = true
          navigation.replace(parentPath, { resume: true })
        }
      }}>
      <SwipePortal inline keepMounted>
        <SwipeViewport className="flex min-h-0 flex-1 max-sm:fixed max-sm:inset-0 max-sm:z-20">
          <SwipePopup data-slot="mobile-page" data-background={!active || undefined}
            className="flex h-full w-full min-w-0 flex-col bg-background outline-none">
            {children}
          </SwipePopup>
        </SwipeViewport>
      </SwipePortal>
    </SwipeRoot>
  </div>
}
