import { useEffect, useRef } from "react"
import { isMobile } from "@alook/shared"
import { requestNativeBack } from "@/components/ui/native-back-layer"

export const MOBILE_BACK_EDGE_PX = 24

export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"

type NativeBackListener = { unregister: () => Promise<void> }
type TauriBackWindow = Window & {
  __TAURI__?: {
    app?: { onBackButtonPress?: (callback: () => void) => Promise<NativeBackListener> }
  }
}

export function useNativeMobileBack({
  mobile = false,
  gestureKey,
  dismissShellOverlay,
  parentPath,
  replacePath,
}: {
  mobile?: boolean
  gestureKey?: string
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
}) {
  const composing = useRef<EventTarget | null>(null)
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
  useEffect(() => {
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      if (composing.current === document.activeElement) return
      if (requestNativeBack(document) !== "none" || dismissShellOverlay()) return
      if (parentPath) replacePath(parentPath)
    }

    let gesture: { id: number; x: number; y: number; horizontal: boolean } | null = null
    const cancel = () => { gesture = null }
    const start = (event: TouchEvent) => {
      cancel()
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      if (touch.clientX < 0 || touch.clientX > MOBILE_BACK_EDGE_PX) return
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false }
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
      if (gesture.horizontal) event.preventDefault()
    }
    const end = (event: TouchEvent) => {
      const current = gesture
      cancel()
      if (!current?.horizontal || event.touches.length !== 0) return
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.id)
      if (!touch) return
      event.preventDefault()
      if (touch.clientX - current.x < 64 || Math.abs(touch.clientY - current.y) >= touch.clientX - current.x) return
      handleBack(event)
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    if (mobile) {
      document.addEventListener("touchstart", start, { passive: true, capture: true })
      document.addEventListener("touchmove", move, { passive: false, capture: true })
      document.addEventListener("touchend", end, { passive: false, capture: true })
      document.addEventListener("touchcancel", cancel, true)
    }
    return () => {
      window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
      document.removeEventListener("touchstart", start, true)
      document.removeEventListener("touchmove", move, true)
      document.removeEventListener("touchend", end, true)
      document.removeEventListener("touchcancel", cancel, true)
    }
  }, [mobile, gestureKey, dismissShellOverlay, parentPath, replacePath])
}
