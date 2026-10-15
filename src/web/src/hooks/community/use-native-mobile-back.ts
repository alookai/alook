import { useEffect, useLayoutEffect, useRef } from "react"

export const MOBILE_BACK_EDGE_PX = 24
export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"
export const NATIVE_MOBILE_BACK_PROGRESS_EVENT = "alook:native-back-progress"

const dismissibleLayerSelector = [
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
].join(",")

function dismissTopDocumentLayer(): boolean {
  if (!document.querySelector(dismissibleLayerSelector)) return false
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", code: "Escape", bubbles: true, cancelable: true,
  }))
  return true
}

export function useNativeMobileBack({
  mobile = false,
  gestureKey,
  dismissShellOverlay,
  parentPath,
  replacePath,
  animate = true,
}: {
  mobile?: boolean
  gestureKey?: string
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
  animate?: boolean
}) {
  const actions = useRef({ dismissShellOverlay, replacePath })
  const nativeGesture = useRef<"active" | "cancelled" | null>(null)
  useLayoutEffect(() => { actions.current = { dismissShellOverlay, replacePath } }, [dismissShellOverlay, replacePath])
  useEffect(() => {
    let root: HTMLElement | null = null
    let nativeProgress = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let gesture: { id: number; x: number; y: number; horizontal: boolean; lastX: number; at: number; velocity: number } | null = null
    const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const reset = () => {
      clearTimeout(timer)
      timer = undefined
      gesture = null
      if (nativeProgress) nativeGesture.current = "cancelled"
      nativeProgress = false
      root?.style.removeProperty("--mobile-back-x")
      root?.style.removeProperty("--mobile-back-progress")
      root?.removeAttribute("data-mobile-back-phase")
      root = null
    }
    const settle = (commit: boolean) => {
      gesture = null
      nativeProgress = false
      if (!root || reduced()) {
        reset()
        if (commit && parentPath) actions.current.replacePath(parentPath)
        return
      }
      root.dataset.mobileBackPhase = "settling"
      root.style.setProperty("--mobile-back-x", commit ? `${root.clientWidth}px` : "0px")
      root.style.setProperty("--mobile-back-progress", commit ? "1" : "0")
      timer = setTimeout(() => {
        timer = undefined
        if (commit && parentPath) {
          root?.setAttribute("data-mobile-back-phase", "committing")
          actions.current.replacePath(parentPath)
        } else reset()
      }, 200)
    }
    const findRoot = () => animate && parentPath && !document.querySelector(dismissibleLayerSelector)
      ? document.querySelector<HTMLElement>('[data-mobile-back-surface="detail"]') : null
    const paint = (x: number) => {
      if (!root) return
      root.dataset.mobileBackPhase = "dragging"
      root.style.setProperty("--mobile-back-x", `${x}px`)
      root.style.setProperty("--mobile-back-progress", `${x / Math.max(1, root.clientWidth)}`)
    }
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      const interrupted = nativeGesture.current === "cancelled"
      nativeGesture.current = null
      if (interrupted) return reset()
      if (timer !== undefined || root?.dataset.mobileBackPhase === "committing") return
      if (dismissTopDocumentLayer() || actions.current.dismissShellOverlay()) return reset()
      if (mobile) root ??= findRoot()
      settle(Boolean(parentPath))
    }
    const progress = (event: Event) => {
      const value = (event as CustomEvent<{ progress: number | null }>).detail?.progress
      if (value === null) {
        nativeGesture.current = null
        if (nativeProgress) settle(false)
        return
      }
      if (!Number.isFinite(value) || timer !== undefined || root?.dataset.mobileBackPhase === "committing") return
      if (!nativeProgress) {
        if (value !== 0) return
        reset()
        nativeGesture.current = "active"
        nativeProgress = true
        root = findRoot()
      }
      if (root) paint(Math.max(0, Math.min(1, value!)) * root.clientWidth)
    }
    const cancel = () => {
      if (gesture?.horizontal && root) settle(false)
      else reset()
    }
    const start = (event: TouchEvent) => {
      if (timer !== undefined || root?.dataset.mobileBackPhase === "committing") return
      reset()
      if (event.touches.length !== 1 || event.defaultPrevented) return
      const touch = event.touches[0]
      if (touch.clientX < 0 || touch.clientX > MOBILE_BACK_EDGE_PX) return
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false,
        lastX: touch.clientX, at: performance.now(), velocity: 0 }
      root = findRoot()
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
      if (root) {
        const x = Math.max(0, Math.min(root.clientWidth, dx))
        paint(x)
      }
    }
    const end = (event: TouchEvent) => {
      const current = gesture
      gesture = null
      if (!current) return
      if (!current.horizontal || event.touches.length !== 0) return cancel()
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.id)
      if (!touch) return cancel()
      event.preventDefault()
      const dx = touch.clientX - current.x
      const horizontal = Math.abs(touch.clientY - current.y) < dx
      const commit = horizontal && (root
        ? dx >= root.clientWidth * 0.35 || dx >= 32 && current.velocity > 0.5 && performance.now() - current.at < 100
        : dx >= 64)
      if (commit && (dismissTopDocumentLayer() || actions.current.dismissShellOverlay())) return settle(false)
      settle(commit)
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    if (mobile) {
      window.addEventListener(NATIVE_MOBILE_BACK_PROGRESS_EVENT, progress)
      document.addEventListener("touchstart", start, { passive: true, capture: true })
      document.addEventListener("touchmove", move, { passive: false, capture: true })
      document.addEventListener("touchend", end, { passive: false, capture: true })
      document.addEventListener("touchcancel", cancel, true)
      document.addEventListener("visibilitychange", reset)
      window.addEventListener("resize", reset)
    }
    return () => {
      reset()
      window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
      window.removeEventListener(NATIVE_MOBILE_BACK_PROGRESS_EVENT, progress)
      document.removeEventListener("touchstart", start, true)
      document.removeEventListener("touchmove", move, true)
      document.removeEventListener("touchend", end, true)
      document.removeEventListener("touchcancel", cancel, true)
      document.removeEventListener("visibilitychange", reset)
      window.removeEventListener("resize", reset)
    }
  }, [mobile, gestureKey, parentPath, animate])
}
