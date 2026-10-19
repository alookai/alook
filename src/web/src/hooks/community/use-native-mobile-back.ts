import { useEffect, useLayoutEffect, useRef } from "react"
import { isMobile, isTauri } from "@alook/shared"
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
  mobile = false, gestureKey, dismissShellOverlay, parentPath, replacePath, animate = true,
}: {
  mobile?: boolean
  gestureKey?: string
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
  animate?: boolean
}) {
  const actions = useRef({ dismissShellOverlay, replacePath, animate })
  const nativeGesture = useRef<"active" | "stale" | null>(null)
  const composing = useRef<EventTarget | null>(null)
  const interruptMotion = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    actions.current = { dismissShellOverlay, replacePath, animate }
    if (!animate) interruptMotion.current()
  }, [dismissShellOverlay, replacePath, animate])
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
    let root: HTMLElement | null = null
    let pageBlocked = false
    let nativeProgress = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopSettling: (() => void) | undefined
    let gesture: { id: number; x: number; y: number; horizontal: boolean; lastX: number; at: number; velocity: number } | null = null
    const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const occupied = () => composing.current === document.activeElement || hasNativeBackOwner(document)
    const clearMotion = () => {
      clearTimeout(timer)
      timer = undefined
      stopSettling?.()
      stopSettling = undefined
      root?.style.removeProperty("--mobile-back-x")
      root?.style.removeProperty("--mobile-back-progress")
      root?.removeAttribute("data-mobile-back-phase")
      root = null
    }
    const reset = () => {
      gesture = null
      nativeProgress = false
      clearMotion()
    }
    const interrupt = () => {
      if (gesture || nativeProgress || root) pageBlocked = true
      clearMotion()
    }
    interruptMotion.current = interrupt
    const ownerChanged = () => { if (occupied()) interrupt() }
    const invalidate = () => {
      if (nativeGesture.current === "active") nativeGesture.current = "stale"
      pageBlocked = true
      reset()
    }
    const findRoot = () => actions.current.animate && parentPath && !occupied()
      ? document.querySelector<HTMLElement>('[data-mobile-back-surface="detail"]') : null
    const settle = (commit: boolean) => {
      const waitForTransition = commit && !isTauri() && !nativeProgress
      gesture = null
      nativeProgress = false
      if (commit && (pageBlocked || occupied())) { reset(); return }
      const foreground = waitForTransition
        ? root?.querySelector<HTMLElement>('[data-mobile-back-thread] [data-panel][id="thread"]')
          ?? root?.querySelector<HTMLElement>('[data-panel][id="main"]')
        : null
      if (!root || reduced() || waitForTransition && !foreground) {
        reset()
        if (commit && parentPath) actions.current.replacePath(parentPath)
        return
      }
      root.dataset.mobileBackPhase = "settling"
      root.style.setProperty("--mobile-back-x", commit ? `${root.clientWidth}px` : "0px")
      root.style.setProperty("--mobile-back-progress", commit ? "1" : "0")
      const finish = () => {
        timer = undefined
        stopSettling?.()
        stopSettling = undefined
        if (commit && parentPath && !pageBlocked && !occupied() && actions.current.animate) {
          root?.setAttribute("data-mobile-back-phase", "committing")
          actions.current.replacePath(parentPath)
        } else reset()
      }
      if (foreground) {
        const complete = (event: TransitionEvent) => {
          if (event.target !== foreground || event.propertyName !== "transform") return
          if (event.type === "transitionend") finish()
          else reset()
        }
        foreground.addEventListener("transitionend", complete)
        foreground.addEventListener("transitioncancel", complete)
        stopSettling = () => {
          foreground.removeEventListener("transitionend", complete)
          foreground.removeEventListener("transitioncancel", complete)
        }
      } else timer = setTimeout(finish, 200)
    }
    const paint = (x: number, follow = true) => {
      if (occupied() || !actions.current.animate) interrupt()
      if (!root || pageBlocked || !follow) return
      root.dataset.mobileBackPhase = "dragging"
      root.style.setProperty("--mobile-back-x", `${x}px`)
      root.style.setProperty("--mobile-back-progress", `${x / Math.max(1, root.clientWidth)}`)
    }
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      const stale = nativeGesture.current === "stale"
      nativeGesture.current = null
      if (stale) { pageBlocked = false; return reset() }
      if (timer !== undefined || stopSettling || root?.dataset.mobileBackPhase === "committing") return
      const blocked = (gesture !== null || nativeProgress) && pageBlocked
      pageBlocked = false
      if (composing.current === document.activeElement) return reset()
      if (requestNativeBack(document) !== "none" || actions.current.dismissShellOverlay()) return reset()
      if (blocked) return reset()
      if (mobile) root ??= findRoot()
      settle(Boolean(parentPath))
    }
    const progress = (event: Event) => {
      const detail = (event as CustomEvent<{ progress: number | null; started?: boolean }>).detail
      const value = detail?.progress
      if (value === null) {
        nativeGesture.current = null
        if (nativeProgress) settle(false)
        return
      }
      if (!Number.isFinite(value) || timer !== undefined || stopSettling || root?.dataset.mobileBackPhase === "committing") return
      if (!nativeProgress) {
        if (value !== 0 || detail?.started !== true) return
        reset()
        nativeGesture.current = "active"
        nativeProgress = true
        pageBlocked = occupied() || !actions.current.animate
        if (!pageBlocked) root = findRoot()
      }
      if (root) paint(Math.max(0, Math.min(1, value!)) * root.clientWidth)
    }
    const cancel = () => {
      if (gesture?.horizontal && root && isTauri()) settle(false)
      else reset()
    }
    const start = (event: TouchEvent) => {
      if (timer !== undefined || stopSettling || root?.dataset.mobileBackPhase === "committing") return
      reset()
      if (event.touches.length !== 1 || event.defaultPrevented) return
      const touch = event.touches[0]
      if (touch.clientX < 0 || touch.clientX > MOBILE_BACK_EDGE_PX) return
      pageBlocked = occupied() || !actions.current.animate
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false,
        lastX: touch.clientX, at: performance.now(), velocity: 0 }
      if (!pageBlocked) root = findRoot()
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
      const now = performance.now()
      gesture.velocity = (touch.clientX - gesture.lastX) / Math.max(1, now - gesture.at)
      gesture.lastX = touch.clientX
      gesture.at = now
      paint(Math.max(0, Math.min(root?.clientWidth ?? 0, dx)), isTauri())
    }
    const end = (event: TouchEvent) => {
      const current = gesture
      if (!current) return
      if (!current.horizontal || event.touches.length !== 0) return cancel()
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.id)
      if (!touch) return cancel()
      const dx = touch.clientX - current.x
      const horizontal = Math.abs(touch.clientY - current.y) < dx
      const commit = horizontal && (root
        ? dx >= root.clientWidth * 0.35 || dx >= 32 && current.velocity > 0.5 && performance.now() - current.at < 100
        : dx >= 64)
      if (commit) handleBack(event)
      else { event.preventDefault(); cancel() }
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    document.addEventListener(NATIVE_BACK_OWNER_CHANGE_EVENT, ownerChanged)
    document.addEventListener("compositionstart", interrupt)
    window.addEventListener("pagehide", invalidate)
    if (mobile) {
      window.addEventListener(NATIVE_MOBILE_BACK_PROGRESS_EVENT, progress)
      if (!/android/i.test(navigator.userAgent)) {
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
      interruptMotion.current = () => {}
      window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
      document.removeEventListener(NATIVE_BACK_OWNER_CHANGE_EVENT, ownerChanged)
      document.removeEventListener("compositionstart", interrupt)
      window.removeEventListener("pagehide", invalidate)
      window.removeEventListener(NATIVE_MOBILE_BACK_PROGRESS_EVENT, progress)
      document.removeEventListener("touchstart", start, true)
      document.removeEventListener("touchmove", move, true)
      document.removeEventListener("touchend", end, true)
      document.removeEventListener("touchcancel", cancel, true)
      document.removeEventListener("visibilitychange", invalidate)
      window.removeEventListener("resize", invalidate)
    }
  }, [mobile, gestureKey, parentPath])
}
