import { useEffect, useLayoutEffect, useRef } from "react"
import { useNativeBackMessages } from "./use-native-back-messages"
import { isMobile } from "@alook/shared"
import type { MobileBackGesture } from "@/lib/community/mobile-back-gesture"
import { hasNativeBackOwner, NATIVE_BACK_OWNER_CHANGE_EVENT, requestNativeBack } from "@/components/ui/native-back-layer"

export const MOBILE_BACK_EDGE_PX = 24
export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"
export const NATIVE_MOBILE_BACK_PROGRESS_EVENT = "alook:native-back-progress"

type NativeBackListener = { unregister: () => Promise<void> }
type TauriBackWindow = Window & {
  __TAURI__?: {
    app?: { onBackButtonPress?: (callback: () => void) => Promise<NativeBackListener> }
  }
}

export function useNativeMobileBack({
  mobile = false, gestureKey, dismissShellOverlay, parentPath, replacePath, pageNavigationEnabled = true, beginBackGesture,
  isBackGestureActive, abortBackGesture,
}: {
  mobile?: boolean
  gestureKey?: string
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
  pageNavigationEnabled?: boolean
  beginBackGesture?: () => MobileBackGesture | null
  isBackGestureActive?: () => boolean
  abortBackGesture?: () => void
}) {
  const nativeInsets = useNativeBackMessages(NATIVE_MOBILE_BACK_EVENT, NATIVE_MOBILE_BACK_PROGRESS_EVENT)
  const actions = useRef({ dismissShellOverlay, replacePath, pageNavigationEnabled, beginBackGesture, isBackGestureActive, abortBackGesture })
  const nativeGesture = useRef<"active" | "stale" | null>(null)
  const composing = useRef<EventTarget | null>(null)
  const interruptInput = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    actions.current = { dismissShellOverlay, replacePath, pageNavigationEnabled, beginBackGesture, isBackGestureActive, abortBackGesture }
    if (!pageNavigationEnabled) interruptInput.current()
  }, [dismissShellOverlay, replacePath, pageNavigationEnabled, beginBackGesture, isBackGestureActive, abortBackGesture])
  useEffect(() => {
    if (!isMobile() || !/android/i.test(navigator.userAgent)) return
    const app = (window as TauriBackWindow).__TAURI__?.app
    if (!app?.onBackButtonPress) return
    const register = app.onBackButtonPress.bind(app)
    const report = (error: unknown) => { console.error("Native Back listener failed", error) }
    const subscribe = () => {
      let active = true
      let listener: NativeBackListener | undefined
      void register(() => {
        if (active) window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true }))
      }).then((registered) => {
        if (active) listener = registered
        else void registered.unregister().catch(report)
      }).catch(report)
      return () => {
        if (!active) return
        active = false
        if (listener) void listener.unregister().catch(report)
      }
    }
    let stop = subscribe()
    const hide = () => { stop() }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      stop()
      stop = subscribe()
    }
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    return () => {
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
      stop()
    }
  }, [])
  useEffect(() => {
    const start = (event: CompositionEvent) => { composing.current = event.target }
    const end = () => { composing.current = null }
    document.addEventListener("compositionstart", start)
    document.addEventListener("compositionend", end)
    document.addEventListener("focusout", end)
    return () => {
      end()
      document.removeEventListener("compositionstart", start)
      document.removeEventListener("compositionend", end)
      document.removeEventListener("focusout", end)
    }
  }, [])
  useLayoutEffect(() => {
    let pageBlocked = false
    let nativeInteraction: MobileBackGesture | null = null
    let gesture: { id: number; x: number; y: number; width: number; horizontal: boolean; interactionStarted: boolean; interaction: MobileBackGesture | null; lastX: number; at: number; velocity: number } | null = null
    const occupied = () => composing.current === document.activeElement || hasNativeBackOwner(document)
    const interrupt = () => {
      if (gesture || nativeGesture.current === "active" || actions.current.isBackGestureActive?.()) {
        pageBlocked = true
        gesture?.interaction?.abort()
        nativeInteraction?.abort()
        actions.current.abortBackGesture?.()
      }
    }
    interruptInput.current = interrupt
    const ownerChanged = () => { if (occupied()) interrupt() }
    const invalidate = () => {
      if (nativeGesture.current === "active") nativeGesture.current = "stale"
      gesture?.interaction?.abort()
      nativeInteraction?.abort()
      actions.current.abortBackGesture?.()
      nativeInteraction = null
      gesture = null
      pageBlocked = true
    }
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      const native = nativeGesture.current
      const interaction = native === "active" ? nativeInteraction : gesture?.interaction
      nativeInteraction = null
      nativeGesture.current = null
      if (native === "stale") { interaction?.abort(); gesture = null; return }
      const blocked = (gesture !== null || native === "active") && pageBlocked
      gesture = null
      pageBlocked = false
      if (composing.current === document.activeElement) { interaction?.abort(); return }
      if (requestNativeBack(document) !== "none" || actions.current.dismissShellOverlay()) { interaction?.abort(); return }
      if (blocked || !parentPath || !actions.current.pageNavigationEnabled) { interaction?.abort(); return }
      if (!interaction?.complete() && !actions.current.isBackGestureActive?.()) actions.current.replacePath(parentPath)
    }
    const nativeLifecycle = (event: Event) => {
      const detail = (event as CustomEvent<{ progress: number | null; started?: boolean }>).detail
      if (detail?.progress === null) {
        nativeInteraction?.cancel()
        nativeInteraction = null
        nativeGesture.current = null
        pageBlocked = false
      } else if (detail?.started === true && detail.progress === 0) {
        const localInteraction = gesture?.interaction
        gesture = null
        nativeGesture.current = "active"
        pageBlocked = occupied() || !actions.current.pageNavigationEnabled
          || !localInteraction && Boolean(actions.current.isBackGestureActive?.())
        if (android || pageBlocked) localInteraction?.abort()
        nativeInteraction = android || pageBlocked ? null : localInteraction ?? actions.current.beginBackGesture?.() ?? null
        nativeInteraction?.update(0)
      } else if (nativeGesture.current === "active" && !pageBlocked && Number.isFinite(detail?.progress)) {
        nativeInteraction?.update(detail.progress!)
      }
    }
    const cancel = () => { gesture?.interaction?.cancel(); gesture = null }
    const nestedControl = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false
      if (target.closest("button, a, input, textarea, select, [role=button], [data-swipe-ignore]")) return true
      for (let node: Element | null = target; node && node !== document.documentElement; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true
      }
      return false
    }
    const reserveEdgePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch" && inGestureRegion(event.clientX)
        && parentPath && actions.current.pageNavigationEnabled && !occupied() && !nestedControl(event.target)) {
        event.stopPropagation()
      }
    }
    const android = /android/i.test(navigator.userAgent)
    const inGestureRegion = (x: number) => {
      if (android && !nativeInsets) return false
      const width = document.documentElement.clientWidth || window.innerWidth
      const style = getComputedStyle(document.documentElement)
      const safeLeft = Math.max(0, Number.parseFloat(style.getPropertyValue("--app-safe-area-left")) || 0)
      const safeRight = Math.max(0, Number.parseFloat(style.getPropertyValue("--app-safe-area-right")) || 0)
      const left = Math.max(safeLeft, android ? nativeInsets!.left * width : 0)
      const right = width - Math.max(safeRight, android ? nativeInsets!.right * width : 0)
      return x >= left && x <= Math.min(left + MOBILE_BACK_EDGE_PX, right)
    }
    const start = (event: TouchEvent) => {
      cancel()
      if (!parentPath || nativeGesture.current === "active" || event.touches.length !== 1
        || event.defaultPrevented || nestedControl(event.target)) return
      const touch = event.touches[0]
      if (!inGestureRegion(touch.clientX)) return
      pageBlocked = occupied() || !actions.current.pageNavigationEnabled || Boolean(actions.current.isBackGestureActive?.())
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, width: document.documentElement.clientWidth,
        horizontal: false, interactionStarted: false, interaction: null, lastX: touch.clientX, at: performance.now(), velocity: 0 }
    }
    const move = (event: TouchEvent) => {
      if (!gesture) return
      if (!event.cancelable) return cancel()
      const touch = event.touches[0]
      if (event.touches.length !== 1 || touch.identifier !== gesture.id) return cancel()
      const dx = touch.clientX - gesture.x
      const dy = Math.abs(touch.clientY - gesture.y)
      if (!gesture.horizontal && Math.max(Math.abs(dx), dy) >= 8) {
        if (dx <= dy) return cancel()
        gesture.horizontal = true
      }
      if (!gesture.horizontal) return
      event.preventDefault()
      if (!gesture.interactionStarted && !pageBlocked) {
        gesture.interactionStarted = true
        gesture.interaction = actions.current.beginBackGesture?.() ?? null
      }
      gesture.interaction?.update(Math.max(0, dx) / Math.max(1, gesture.width || window.innerWidth))
      const now = performance.now()
      gesture.velocity = (touch.clientX - gesture.lastX) / Math.max(4, now - gesture.at)
      gesture.lastX = touch.clientX
      gesture.at = now
    }
    const end = (event: TouchEvent) => {
      const current = gesture
      if (!current) return
      if (!current.horizontal || event.touches.length !== 0) return cancel()
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.id)
      if (!touch) return cancel()
      const dx = touch.clientX - current.x
      const horizontal = Math.abs(touch.clientY - current.y) < dx
      const age = performance.now() - current.at
      const velocity = touch.clientX === current.lastX
        ? age < 80 ? current.velocity : 0
        : (touch.clientX - current.lastX) / Math.max(4, age)
      const commit = horizontal && (current.width > 0
        ? velocity >= -0.5 && (dx >= current.width * 0.5 || dx >= 32 && velocity > 0.5)
        : dx >= 64)
      if (commit) handleBack(event)
      else { event.preventDefault(); cancel() }
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    document.addEventListener(NATIVE_BACK_OWNER_CHANGE_EVENT, ownerChanged)
    document.addEventListener("compositionstart", interrupt)
    window.addEventListener("pagehide", invalidate)
    if (mobile) {
      window.addEventListener(NATIVE_MOBILE_BACK_PROGRESS_EVENT, nativeLifecycle)
      if (!android || nativeInsets) {
        document.addEventListener("pointerdown", reserveEdgePointer, true)
        document.addEventListener("touchstart", start, { passive: true, capture: true })
        document.addEventListener("touchmove", move, { passive: false, capture: true })
        document.addEventListener("touchend", end, { passive: false, capture: true })
        document.addEventListener("touchcancel", cancel, true)
      }
      document.addEventListener("visibilitychange", invalidate)
      window.addEventListener("resize", invalidate)
    }
    return () => {
      invalidate()
      interruptInput.current = () => {}
      window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
      document.removeEventListener(NATIVE_BACK_OWNER_CHANGE_EVENT, ownerChanged)
      document.removeEventListener("compositionstart", interrupt)
      window.removeEventListener("pagehide", invalidate)
      window.removeEventListener(NATIVE_MOBILE_BACK_PROGRESS_EVENT, nativeLifecycle)
      document.removeEventListener("pointerdown", reserveEdgePointer, true)
      document.removeEventListener("touchstart", start, true)
      document.removeEventListener("touchmove", move, true)
      document.removeEventListener("touchend", end, true)
      document.removeEventListener("touchcancel", cancel, true)
      document.removeEventListener("visibilitychange", invalidate)
      window.removeEventListener("resize", invalidate)
    }
  }, [mobile, gestureKey, parentPath, nativeInsets])
}
