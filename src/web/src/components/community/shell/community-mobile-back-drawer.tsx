"use client"

import { Drawer } from "@base-ui/react/drawer"
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { CommunityNavigationController } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { hasNativeBackOwner, NATIVE_BACK_OWNER_CHANGE_EVENT } from "@/components/ui/native-back-layer"
import { MOBILE_BACK_EDGE_PX } from "@/hooks/community/use-native-mobile-back"

type BackDrawer = {
  mobile: boolean
  enabled: boolean
  frameKey: string
  targetHref: string
  parentHref: string | null
  navigation: CommunityNavigationController
  nativeInsets: { left: number; right: number } | null
}

export const CommunityMobileBackContext = createContext<BackDrawer | null>(null)

export function useCommunityMobileBackParent() {
  const context = useContext(CommunityMobileBackContext)
  return context?.mobile && context.parentHref ? normalizeCommunityHref(context.parentHref).surface : null
}

function isInteractiveTarget(target: EventTarget | null, boundary: Element) {
  if (!(target instanceof Element)) return true
  for (let node: Element | null = target; node && node !== boundary; node = node.parentElement) {
    if (node.matches('button, a, input, textarea, select, [role="button"], [role="textbox"], [contenteditable]:not([contenteditable="false"]), [data-swipe-ignore], [data-base-ui-swipe-ignore]')) return true
    if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true
  }
  return false
}

type Closing = { href: string; current: () => boolean; submitted?: boolean }

export function CommunityMobileBackDrawer({ level, children }: { level: "list" | "detail"; children: ReactNode }) {
  const context = useContext(CommunityMobileBackContext)
  const [cycle, setCycle] = useState<{ key: string | undefined; closing: Closing | null }>({ key: context?.frameKey, closing: null })
  const intent = useRef<Closing | null>(null)
  const focusTarget = useRef<{ key: string; element: HTMLElement; restore: boolean } | null>(null)
  const composing = useRef(false)
  const mounted = useRef(false)
  if (cycle.key !== context?.frameKey || cycle.closing && (!cycle.closing.current()
    || !cycle.closing.submitted && !context?.enabled
    || context?.navigation.pendingHref && context.navigation.pendingHref !== cycle.closing.href)) {
    setCycle({ key: context?.frameKey, closing: null })
  }
  const active = !!context?.mobile && normalizeCommunityHref(context.targetHref).surface === "detail"
    && !!context.parentHref && normalizeCommunityHref(context.parentHref).surface === level
  useEffect(() => {
    mounted.current = true
    const restore = () => {
      intent.current = null
      focusTarget.current = null
      setCycle(current => current.closing && !current.closing.submitted ? { ...current, closing: null } : current)
    }
    const start = () => { composing.current = true; restore() }
    const end = () => { composing.current = false }
    const owner = () => { if (hasNativeBackOwner(document)) restore() }
    const focus = (event: FocusEvent) => {
      if (focusTarget.current && event.target !== document.body && event.target !== focusTarget.current.element) focusTarget.current = null
    }
    document.addEventListener("compositionstart", start)
    document.addEventListener("compositionend", end)
    document.addEventListener("focusout", end)
    document.addEventListener(NATIVE_BACK_OWNER_CHANGE_EVENT, owner)
    document.addEventListener("focusin", focus)
    return () => {
      mounted.current = false
      intent.current = null
      document.removeEventListener("compositionstart", start)
      document.removeEventListener("compositionend", end)
      document.removeEventListener("focusout", end)
      document.removeEventListener(NATIVE_BACK_OWNER_CHANGE_EVENT, owner)
      document.removeEventListener("focusin", focus)
    }
  }, [])
  const restoreFocus = useCallback(() => {
    if (!mounted.current) return
    const captured = focusTarget.current
    if (!captured) return
    if (captured.key !== context?.frameKey || !captured.element.isConnected
      || composing.current || hasNativeBackOwner(document)) { focusTarget.current = null; return }
    if (!captured.restore || cycle.closing || !active || !context?.enabled
      || captured.element.closest("[hidden], [inert]")) return
    focusTarget.current = null
    const focused = document.activeElement
    if (focused === document.body || focused === captured.element) captured.element.focus({ preventScroll: true })
  }, [active, context, cycle.closing])
  useLayoutEffect(restoreFocus, [restoreFocus])
  if (!context) return children
  const eligible = (x: number, target: EventTarget | null, boundary: HTMLElement) => {
    if (!active || !context.enabled || composing.current || hasNativeBackOwner(document)
      || isInteractiveTarget(target, boundary)) return false
    const android = /android/i.test(navigator.userAgent)
    const bridge = (window as Window & { AlookBack?: { postMessage?: unknown } }).AlookBack?.postMessage
    if (android && bridge && !context.nativeInsets) return false
    const width = document.documentElement.clientWidth || window.innerWidth
    const style = getComputedStyle(document.documentElement)
    const safeLeft = Math.max(0, Number.parseFloat(style.getPropertyValue("--app-safe-area-left")) || 0)
    const safeRight = Math.max(0, Number.parseFloat(style.getPropertyValue("--app-safe-area-right")) || 0)
    const left = Math.max(safeLeft, android ? context.nativeInsets ? context.nativeInsets.left * width : MOBILE_BACK_EDGE_PX : 0)
    const right = width - Math.max(safeRight, android && context.nativeInsets ? context.nativeInsets.right * width : 0)
    return x >= left && x <= Math.min(left + MOBILE_BACK_EDGE_PX, right)
  }
  return <Drawer.Root open={!cycle.closing} modal={false} disablePointerDismissal closeWatcher={false} swipeDirection="right"
    onOpenChange={(open, details) => {
      const captured = intent.current
      if (open || details.reason !== "swipe" || details.event.type === "touchcancel" || details.event.type === "pointercancel"
        || !active || !context.enabled || composing.current
        || hasNativeBackOwner(document) || !captured?.current()) {
        details.cancel()
        details.allowPropagation()
        return
      }
      intent.current = null
      if (focusTarget.current) focusTarget.current.restore = true
      setCycle({ key: context.frameKey, closing: captured })
    }}
    onOpenChangeComplete={(open) => {
      if (open) { restoreFocus(); return }
      const closing = cycle.closing
      if (!mounted.current || !closing || closing.submitted) return
      if (!active || !context.enabled || composing.current || hasNativeBackOwner(document) || !closing.current()) {
        setCycle({ key: context.frameKey, closing: null })
        return
      }
      const pendingCurrent = context.navigation.captureIntent({ nextCommitHref: closing.href })
      setCycle({ key: context.frameKey, closing: { ...closing, submitted: true,
        current: () => closing.current() || pendingCurrent() } })
      try {
        context.navigation.replace(closing.href, { transitionTypes: [] })
      } catch (error) {
        setCycle({ key: context.frameKey, closing: null })
        throw error
      }
    }}>
    <Drawer.Portal inline keepMounted className="community-back-drawer-host">
    <Drawer.Viewport className="community-back-drawer-viewport" data-community-back-drawer={active || undefined}
      onPointerDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest(".community-back-drawer-viewport") !== event.currentTarget) {
          event.currentTarget.removeAttribute("data-base-ui-swipe-ignore")
          return
        }
        const allowed = event.pointerType === "touch" && eligible(event.clientX, event.target, event.currentTarget)
        event.currentTarget.toggleAttribute("data-base-ui-swipe-ignore", !allowed)
        if (allowed) event.stopPropagation()
      }}
      onTouchStartCapture={(event) => {
        if (event.target instanceof Element && event.target.closest(".community-back-drawer-viewport") !== event.currentTarget) {
          event.currentTarget.removeAttribute("data-base-ui-swipe-ignore")
          return
        }
        const touch = event.touches.length === 1 ? event.touches[0] : undefined
        const allowed = !!touch && !event.defaultPrevented && eligible(touch.clientX, event.target, event.currentTarget)
        event.currentTarget.toggleAttribute("data-base-ui-swipe-ignore", !allowed)
        intent.current = allowed ? { href: context.parentHref!, current: context.navigation.captureIntent() } : null
        const focused = document.activeElement
        focusTarget.current = allowed && focused instanceof HTMLElement && event.currentTarget.contains(focused)
          ? { key: context.frameKey, element: focused, restore: false } : null
      }}>
      <Drawer.Popup role="presentation" initialFocus={false} finalFocus={false} className="community-back-drawer-popup">
        {children}
      </Drawer.Popup>
    </Drawer.Viewport>
    </Drawer.Portal>
  </Drawer.Root>
}
